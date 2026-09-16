// ===== 知识大陆（大陆计划 v1 投影 + v2 簇间边 + v3 边界城市 + v4 证据卫生 + v5 城市与群岛）=====
// 主图是投影层：聚簇与共享概念全部来自 GET /api/continent（服务端从 knowledge +
// sessions 现算），本文件绝不写任何 phymathia_graph_ 会话键——子图（各会话探索
// 网）是唯一事实源，主图随时可重算。
// v2 起主图拥有**自己的**簇间边（KV `continent_edges`，经 /api/kv 读写）：
// 「连接」模式点两个不同区域的概念完成落笔；端点失效的边渲染成断桥，工具条提供
// 清理入口；撤销栈只记边操作（新增/删除/清理/改备注），视口平移缩放不入栈。
// v3 给共享概念的端点卡挂 ◈ 徽标；v4 做证据卫生（弱证据不上图，只进折叠清单）。
// v5.1 共享概念从「弧线 + 浮空标签」升级为**边界城市**：城市摆在它所连的岛之间的
// 走廊里（摆不下进折叠清单，不许叠在岛上），每座岛伸一根辐条连到代表卡；点城市弹
// **重逢清单**（每座岛一行 + 「去看」），绝不替用户猜该跳哪座岛。
// v5.2 群岛布局：岛的摆放从「最近更新排网格」改为**亲缘排序**（强共享概念 + 用户
// 航线）+ 蛇形填充——讲同一主题的岛自然挨成一片，位置本身就是联系，一根线不画。
// v5.3 折叠清单「问 Φ」：机器没把握的折叠行可让 Φ 出一句人话判断；判断块里带
// 「画成大陆边」芯片，落笔权永远在用户（走 /api/models/chat 的 stream:false 通道）。
// v5.4 岛牌一句话 + 空态引导：岛头副行「前 3 个概念名 + 最近更新」（纯拼接）；
// 没有共享连线时顶栏明示点亮机制——空态是引导，不是缺陷。
// v5.5 汇聚口径修正：① 弱证据（2 字共享串）参与**摆位**但不参与断言——梯度/散度这类
// 真关系以前既不画线也不影响摆位，地图看起来「一片孤岛」；② 证据被更具体标签完全覆盖
// 的标签（截断名，如「量守恒定律」）不再单独成城，折进清单（原因「已被更具体的城市
// 覆盖」）——地图上不再出现两座几乎重合、名字还读不懂的城。
// 交互三层口径（游戏地图模型：层级离散、整层切换，不是连续语义缩放）：
// - 下钻：点簇 / 概念节点 → 镜头向点击处推进（转场动画）→ switchToSession，
//   概念节点再经 goToKnowledgeNode 直达定位（等于点 POI 而非进城门口）；
// - 返回：探索网面包屑「‹ 大陆」→ 恢复离开时的平移缩放视口（回来还在原地）；
// - 视图自身克制编辑：只有簇间边一种写路径，Esc / 关闭按钮收起。

const CONTINENT_VIEW_KEY = 'phymathia_continent_view'; // 视口记忆（非会话键）
const CONTINENT_EDGES_API = '/api/kv/continent_edges'; // 主图簇间边的读写端点（现成 KV 通道）
const CONTINENT_LINE_LIMIT = 24;      // 与服务端 SHARED_CONCEPT_LIMIT 同口径的二次保险
// v5.1 边界城市：同一对区域之间最多几座城（沿用 v4「每对上限」的精神）+ 全图总量上限。
// 城市尺寸按「摆得进两岛之间的走廊」定：CONTINENT_CLUSTER_GAP = 150，城市 112 宽
// 居中放进去两侧各余 19px，够本；再宽就必然压到岛上。
const CONTINENT_PAIR_CITY_LIMIT = 3;
const CONTINENT_CITY_LIMIT = 12;
const CONTINENT_CITY_W = 112;
const CONTINENT_CITY_H = 32;
const CONTINENT_CITY_GAP = 8;         // 城市与岛、城市与城市的最小间隙
const CONTINENT_USER_EDGE_LIMIT = 120; // 与服务端 USER_EDGE_LIMIT 同口径
const CONTINENT_NODE_W = 160;
const CONTINENT_NODE_H = 46;
const CONTINENT_COLS = 3;             // 簇内概念排几列
const CONTINENT_GAP = 10;
const CONTINENT_PAD = 18;
const CONTINENT_HEADER_H = 36;
const CONTINENT_CLUSTER_GAP = 150;
const CONTINENT_WORLD_MARGIN = 60;
const CONTINENT_ZOOM_MIN = 0.3;
const CONTINENT_ZOOM_MAX = 2.5;
const CONTINENT_DIVE_MS = 430;
const CONTINENT_DIVE_FACTOR = 2.6;
const CONTINENT_SURFACE_FACTOR = 1.14;

let _continentOpen = false;
let _continentDrilling = false;
let _continentPan = { x: 0, y: 0 };
let _continentZoom = 1;
let _continentPlacements = {};  // itemId → {x,y,w,h,cx,cy}（世界坐标，布局解析算出）
let _continentClusterRects = [];
let _continentKeyHandler = null;
let _continentDragState = null;
let _continentSkipViewPersist = false;
let _continentData = null;         // 最近一次投影数据（边操作后就地刷新）
let _continentLinkMode = false;    // v2 连接模式
let _continentLinkSource = null;   // {itemId, sessionId}
let _continentEdgeUndo = [];       // 撤销栈：只记边操作，视口变化不入栈
let _continentPopover = null;      // 单例弹层（共享概念详情 / 我的边操作）
let _continentFolded = [];         // v4 折叠清单：[{entry, reason}]（weak=弱证据 / covered=已被更具体的城市覆盖 / capped=超出每对上限 / map_capped=超出全图上限 / no_room=无位可放）
let _continentGuideText = '';      // v5.4 顶栏空态引导文案（空串=不该显示）
const _continentPhiInflight = new Set(); // v5.3 在途「问 Φ」请求：弹层关闭时全部中止

function _continentEsc(text) {
  if (typeof escapeHtml === 'function') return escapeHtml(text);
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _continentToast(msg) {
  if (typeof showToast === 'function') showToast(msg);
}

// 节点公式：渲成一行小字 KaTeX（不占地图视觉重量）；溢出交给容器裁剪，
// 库缺失/渲染失败回退纯文本。TeX 先过 _cleanFormulaLatex（剥 $ 定界符等，
// 与主渲染链路同一把尺子）。
function _continentRenderFormula(el, latex) {
  let tex = String(latex || '');
  if (typeof _cleanFormulaLatex === 'function') tex = _cleanFormulaLatex(tex);
  else tex = tex.replace(/^\$+|\$+$/g, '').trim();
  if (!tex) { if (el.textContent !== undefined) el.textContent = ''; return; }
  if (typeof katex !== 'undefined' && katex && typeof katex.render === 'function') {
    try {
      katex.render(tex, el, { throwOnError: false, displayMode: false });
      return;
    } catch (e) { /* 回退纯文本 */ }
  }
  if (el.textContent !== undefined) el.textContent = tex;
}

// ---------- v5.2 群岛布局：亲缘排序（位置本身就是联系，纯函数无 DOM） ----------
// 亲缘三个来源：① 强共享概念（≥3 字实词或公式共享）每个跨会话对记 1 分；② 弱共享
// 概念（「振动」「梯度」这类 2 字证据）每个跨会话对记 0.3 分、每对累计封顶 0.9——v5.5
// 起弱证据参与摆位：摆位**不宣称任何概念同一性**（不画线、不建城），是风险最低的表达，
// 正该承接最弱的证据；封顶保证任意多条弱证据都压不过一条强证据。③ 用户亲手画的大陆边
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

// ---------- 纯布局：簇网格摆放，簇内概念流式网格；坐标全部解析算出，无需 DOM 实测 ----------
function _continentLayoutClusters(clusters) {
  const placements = {};
  const clusterRects = [];
  const measured = (clusters || []).map(c => {
    const n = Math.max(1, (c.items || []).length);
    const cols = Math.min(CONTINENT_COLS, n);
    const rows = Math.ceil(n / cols);
    return {
      cluster: c, cols, rows,
      w: CONTINENT_PAD * 2 + cols * CONTINENT_NODE_W + (cols - 1) * CONTINENT_GAP,
      h: CONTINENT_PAD * 2 + CONTINENT_HEADER_H + rows * CONTINENT_NODE_H + (rows - 1) * CONTINENT_GAP,
    };
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(measured.length)));
  // v5.2 蛇形填充：奇数行从右往左走。两个循环（列宽/行高统计与落位）必须用同一
  // 个映射，否则列宽统计与实际落位对不上——岛会摆进没按它撑宽的列里
  const gridPos = i => {
    const ri = Math.floor(i / cols), posInRow = i % cols;
    return { ci: ri % 2 === 1 ? cols - 1 - posInRow : posInRow, ri: ri };
  };
  const colW = [], rowH = [];
  measured.forEach((m, i) => {
    const g = gridPos(i);
    colW[g.ci] = Math.max(colW[g.ci] || 0, m.w);
    rowH[g.ri] = Math.max(rowH[g.ri] || 0, m.h);
  });
  // 两个累加器必须分开：以前列、行共用同一个 acc，worldW 实际拿到的是**行**的累加值
  // （worldW === worldH），多列布局下世界宽度被算小 → 适配画布按假宽度算，地图一开
  // 就被裁掉右半边（真机截图才发现：岛排到 x=1628，世界却声明 674 宽）
  const colX = [], rowY = [];
  let accX = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < colW.length; i++) { colX.push(accX); accX += colW[i] + CONTINENT_CLUSTER_GAP; }
  let accY = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < rowH.length; i++) { rowY.push(accY); accY += rowH[i] + CONTINENT_CLUSTER_GAP; }
  const worldW = Math.max(400, accX - CONTINENT_CLUSTER_GAP + CONTINENT_WORLD_MARGIN);
  const worldH = Math.max(300, accY - CONTINENT_CLUSTER_GAP + CONTINENT_WORLD_MARGIN);
  measured.forEach((m, i) => {
    const g = gridPos(i);
    const x = colX[g.ci] + (colW[g.ci] - m.w) / 2;
    const y = rowY[g.ri] + (rowH[g.ri] - m.h) / 2;
    clusterRects.push({
      sessionId: m.cluster.sessionId, title: m.cluster.title || '',
      x, y, w: m.w, h: m.h, cx: x + m.w / 2, cy: y + m.h / 2,
      itemCount: (m.cluster.items || []).length,
    });
    (m.cluster.items || []).forEach((item, j) => {
      const icol = j % m.cols, irow = Math.floor(j / m.cols);
      const nx = x + CONTINENT_PAD + icol * (CONTINENT_NODE_W + CONTINENT_GAP);
      const ny = y + CONTINENT_PAD + CONTINENT_HEADER_H + irow * (CONTINENT_NODE_H + CONTINENT_GAP);
      placements[item.itemId] = {
        x: nx, y: ny, w: CONTINENT_NODE_W, h: CONTINENT_NODE_H,
        cx: nx + CONTINENT_NODE_W / 2, cy: ny + CONTINENT_NODE_H / 2,
      };
    });
  });
  return { placements, clusterRects, worldW, worldH };
}

// ---------- 数据 ----------
async function _continentFetchData() {
  const resp = await fetch('/api/continent', { cache: 'no-cache' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  if (!data || !Array.isArray(data.clusters)) throw new Error('投影数据格式不符');
  return data;
}

function _continentItemIndex() {
  const d = _continentData || {};
  const items = {}, clusterTitles = {}, itemSession = {}, itemCreated = {}, itemSummary = {};
  (d.clusters || []).forEach(c => {
    clusterTitles[c.sessionId] = c.title || '未命名画布';
    (c.items || []).forEach(it => {
      items[it.itemId] = it.title || '';
      itemSession[it.itemId] = c.sessionId;
      itemCreated[it.itemId] = it.createdAt || 0;
      // v5.3「问 Φ」的判断素材（服务端只带 model/manual 的真摘要，local 模板为空串）
      itemSummary[it.itemId] = it.summary || '';
    });
  });
  return { items, clusterTitles, itemSession, itemCreated, itemSummary };
}

function _continentNodeEl(itemId) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelector) return null;
  const safe = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(itemId)) : String(itemId);
  return world.querySelector('.continent-node[data-item-id="' + safe + '"]');
}

// ---------- DOM ----------
function _continentEnsureLayer() {
  let layer = document.getElementById('continentLayer');
  if (layer) return layer;
  const ws = document.getElementById('graphWorkspace');
  if (!ws || typeof ws.appendChild !== 'function') return null;
  layer = document.createElement('div');
  layer.id = 'continentLayer';
  layer.className = 'continent-layer';
  layer.hidden = true;
  layer.innerHTML =
    '<div class="continent-topbar">' +
      '<div class="continent-brand"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><ellipse cx="12" cy="12" rx="4.5" ry="9"></ellipse></svg>' +
      '知识大陆<span class="continent-sub" id="continentStats"></span></div>' +
      '<div class="continent-tools">' +
        '<button class="continent-tool" id="continentLinkBtn" title="连接两个不同区域的概念（画一条大陆边）">连接</button>' +
        '<button class="continent-tool is-quiet" id="continentWeakBtn" title="没画到地图上的共享点（弱证据 / 超上限 / 无位可放）：照报，可逐条确认落笔" hidden>折叠 0 条</button>' +
        '<button class="continent-tool" id="continentUndoBtn" title="撤销上一条边操作 (Ctrl+Z)" hidden>↩ 撤销</button>' +
        '<button class="continent-tool is-warn" id="continentCleanBtn" title="移除一端已不在大陆上的连线" hidden>清理断线</button>' +
      '</div>' +
      '<span class="continent-hint" id="continentHint" hidden></span>' +
      '<span class="continent-hint" id="continentGuide" hidden></span>' +
      '<button class="continent-close" id="continentCloseBtn" title="收起大陆 (Esc)">&times;</button>' +
    '</div>' +
    '<div class="continent-viewport" id="continentViewport">' +
      '<div class="continent-world" id="continentWorld"></div>' +
      '<div class="continent-empty" id="continentEmpty" hidden>大陆还在形成中——先去画布上学点什么，概念会自己长出来。</div>' +
    '</div>';
  ws.appendChild(layer);
  _continentBindViewport(document.getElementById('continentViewport'));
  const closeBtn = document.getElementById('continentCloseBtn');
  if (closeBtn && closeBtn.addEventListener) closeBtn.addEventListener('click', () => closeContinentView());
  const linkBtn = document.getElementById('continentLinkBtn');
  if (linkBtn && linkBtn.addEventListener) linkBtn.addEventListener('click', () => _continentSetLinkMode(!_continentLinkMode));
  const undoBtn = document.getElementById('continentUndoBtn');
  if (undoBtn && undoBtn.addEventListener) undoBtn.addEventListener('click', () => { _continentUndoEdgeOp(); });
  const cleanBtn = document.getElementById('continentCleanBtn');
  if (cleanBtn && cleanBtn.addEventListener) cleanBtn.addEventListener('click', () => { _continentCleanDangling(); });
  const weakBtn = document.getElementById('continentWeakBtn');
  if (weakBtn && weakBtn.addEventListener) weakBtn.addEventListener('click', e => { _continentFoldedPopover(e); });
  // 弹层单例的场外关闭：捕获阶段先于画布交互，点弹层内部不关
  document.addEventListener('pointerdown', e => {
    if (!_continentPopover) return;
    if (_continentPopover.contains && _continentPopover.contains(e.target)) return;
    _continentClosePopover();
  }, true);
  return layer;
}

// ---------- v4/v5.1 画什么：城市选位 + 每对区域上限 + 折叠原因（纯函数，无 DOM 实测） ----------
// 一枚城市 = 一条跨 ≥2 画布的共享概念（同词跨 N 会话仍是一枚，不是每条链路一枚）。
// v4 的「弧线 + 浮空标签」在 v5.1 整体退役：共享概念升级为岛与岛之间的**城市节点**，
// 每座岛伸一根辐条连到该岛的代表卡；摆不下（撞岛 / 撞别的城）就进折叠清单（原因
// 「无位可放」）——绝不叠在别的岛上。弱证据照旧不上图，只进清单。
function _continentLinkMid(a, b) {
  // 二次贝塞尔（控制点上抬 lift）上 t=0.5 的点：与连线绘制同一公式，标签才落在弧上
  const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const len = Math.max(1, Math.hypot(dx, dy));
  const lift = Math.min(60, len * 0.14);
  const qx = mx + (-dy / len) * lift, qy = my + (dx / len) * lift;
  return { x: (a.cx + 2 * qx + b.cx) / 4, y: (a.cy + 2 * qy + b.cy) / 4, qx, qy };
}

// 大陆边「备注」的落点（纯函数，smoke 直测）：就是上面那条曲线在 t=0.5 的中点，
// 与连线同一套世界坐标，标签才压在线上。
// 曾经这里直接读 `arcPath(...)` 返回值的 `arc.qx`——而 arcPath 只返回了 `d`，于是
// left/top 算成字符串 `"NaNpx"`：这是**无效 CSS 值**，会被浏览器整条丢弃，绝对定位的
// 标签退回「静态位置」（世界层左上角，紧跟在 SVG 之后）——备注就飘到离连线十万八千里
// 的地方，而且控制台一声不响（用户截图：「文字不在线上」）。
// 教训：给 DOM 写 `xxx + 'px'` 的落点必须有 finite 兜底 + 断言，NaN 在浏览器里是静默失败。
function _continentEdgeLabelPos(a, b) {
  const mid = _continentLinkMid(a, b);
  const ax = Number.isFinite(a.cx) ? a.cx : 0, bx = Number.isFinite(b.cx) ? b.cx : 0;
  const ay = Number.isFinite(a.cy) ? a.cy : 0, by = Number.isFinite(b.cy) ? b.cy : 0;
  return {
    x: Number.isFinite(mid.x) ? mid.x : (ax + bx) / 2,
    y: Number.isFinite(mid.y) ? mid.y : (ay + by) / 2,
  };
}

function _continentCityBox(cx, cy) {
  return {
    x: cx - CONTINENT_CITY_W / 2, y: cy - CONTINENT_CITY_H / 2,
    w: CONTINENT_CITY_W, h: CONTINENT_CITY_H, cx: cx, cy: cy,
  };
}

// 城市候选落点：所连岛群的质心 + 每对岛的中点（两岛之间的走廊 = 首选），各带一圈
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

// 世界边界（岛群包围盒 + 一个走廊宽）：城市属于「岛之间」，不许飘到地图外的荒野
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

// 城市选位：候选里挑「不撞岛、不撞别的城、留在世界内」且**离它所连的岛总距离最短**
// 的那个（辐条最短最好读）。一个都放不下 → null（调用方折叠，原因「无位可放」）。
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
  covered: '已被更具体的城市覆盖',
  capped: '超出每对上限',
  map_capped: '超出全图上限',
  no_room: '无位可放',
};

function _continentDrawPlan(shared, placements, clusterRects, pairLimit, cityLimit) {
  const rects = clusterRects || [];
  const pairLimitN = pairLimit || CONTINENT_PAIR_CITY_LIMIT;
  const cityLimitN = cityLimit || CONTINENT_CITY_LIMIT;
  const cities = [], boundary = {}, folded = [];
  const obstacles = rects.slice();
  const bounds = _continentWorldBounds(rects);
  const pairs = {};
  let spokes = 0;
  (shared || []).slice(0, CONTINENT_LINE_LIMIT).forEach(s => {
    if (s.strength === 'weak') { folded.push({ entry: s, reason: 'weak' }); return; }
    // v5.5：证据被更具体的标签完全覆盖（服务端 covered 字段）——比如 8 座岛的「能量
    // 守恒定律」+ 2 座岛的「角动量守恒定律」旁边的那个 10 座岛「量守恒定律」（截断名）。
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
    // 一栋楼要有两座以上的岛才叫边界城市（单岛共享是同岛词面重叠，服务端已经不算）
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
    // 代表卡挂 ◈ 徽标（辐条一眼看得到头）；同岛的其他命中卡不挂徽标，但进重逢清单
    reps.forEach(r => { boundary[r.itemId] = s.label; });
    cities.push({ entry: s, reps: reps, total: reps.length,
                  x: box.cx, y: box.cy, box: box });
  });
  return { cities: cities, boundary: boundary, cityCount: cities.length,
           spokeCount: spokes, folded: folded };
}

function _continentRender(data) {
  const world = document.getElementById('continentWorld');
  if (!world) return null;
  world.innerHTML = '';
  // v5.2 群岛布局：亲缘排序（强共享概念 + 用户航线）→ 蛇形网格——讲同一主题的岛
  // 自然挨成一片，位置本身就是联系；无亲缘时输出与原序一致，行为不变
  const layout = _continentLayoutClusters(
    _continentClusterOrder(data.clusters || [], data.shared || [], data.userEdges || []));
  _continentPlacements = layout.placements;
  _continentClusterRects = layout.clusterRects;
  world.style.width = layout.worldW + 'px';
  world.style.height = layout.worldH + 'px';

  const esc = _continentEsc;
  // 边界城市（v5.1）：共享概念的端点条目 → 概念名 → 共享词。只认**画到地图上**的那些
  // （强证据、没超上限、有位置）——弱证据不该把节点标成边界城市。
  const plan = _continentDrawPlan(data.shared || [], layout.placements,
    layout.clusterRects, CONTINENT_PAIR_CITY_LIMIT, CONTINENT_CITY_LIMIT);
  const boundary = plan.boundary;
  _continentFolded = plan.folded;

  // 簇底板（区域图的地皮）。岛牌一句话（v5.4）：前 3 个概念名 + 最近更新时间——
  // 纯拼接、不调模型；看懂岛是看懂联系的前提。
  layout.clusterRects.forEach(rect => {
    const cluster = (data.clusters || []).find(c => c.sessionId === rect.sessionId);
    const tagline = _continentIslandTagline(cluster, _continentRelTime);
    const el = document.createElement('div');
    el.className = 'continent-cluster';
    el.dataset.sessionId = rect.sessionId || '';
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    el.innerHTML =
      '<div class="continent-cluster-head">' +
        '<span class="continent-cluster-headline">' +
          '<span class="continent-cluster-title">' + esc(rect.title) + '</span>' +
          '<span class="continent-cluster-count">' + rect.itemCount + ' 个概念</span>' +
        '</span>' +
        (tagline ? '<span class="continent-cluster-sub">' + esc(tagline) + '</span>' : '') +
      '</div>';
    world.appendChild(el);
  });

  // 概念节点（POI）：标题一行 + 公式渲成一行小字 KaTeX（简略口径，容器裁剪）
  (data.clusters || []).forEach(c => (c.items || []).forEach(item => {
    const p = layout.placements[item.itemId];
    if (!p) return;
    const el = document.createElement('div');
    el.className = 'continent-node' + (boundary[item.itemId] ? ' continent-node--boundary' : '');
    el.dataset.sessionId = c.sessionId || '';
    el.dataset.itemId = item.itemId;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    if (boundary[item.itemId]) {
      el.title = '边界城市：其他画布也学过（共享「' + boundary[item.itemId] + '」）';
    }
    let html = '<div class="continent-node-title">' + esc(item.title) + '</div>';
    if (item.formula || item.formulaPreview) {
      html += '<div class="continent-node-formula"></div>';
    }
    if (boundary[item.itemId]) {
      html += '<span class="continent-node-badge" aria-hidden="true">◈</span>';
    }
    el.innerHTML = html;
    const fEl = el.querySelector ? el.querySelector('.continent-node-formula') : null;
    if (fEl) _continentRenderFormula(fEl, item.formula || item.formulaPreview);
    world.appendChild(el);
  }));

  // 边界城市（v5.1）：共享概念的「地点」——摆在它所连的岛之间的走廊里，每座岛一根
  // 辐条连到代表卡。点开是**重逢清单**（每座岛学过的那些卡 + 「去看」）：绝不替你猜
  // 跳哪座岛，机器猜「最近学的」总有一半时候不是你想去的。
  plan.cities.forEach(city => {
    const s = city.entry || {};
    const el = document.createElement('div');
    el.className = 'continent-city' + (s.kind === 'formula' ? ' is-formula' : '');
    el.dataset.cityLabel = s.label || '';
    el.style.left = city.box.x + 'px';
    el.style.top = city.box.y + 'px';
    el.title = '边界城市：' + city.reps.length + ' 块画布都学过——点开看重逢清单';
    el.innerHTML = '<span class="continent-city-name">' +
      (s.kind === 'formula' ? '∑ ' : '◈ ') + esc(s.label || '') + '</span>';
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();  // 标签/用户边同规：不让城市点击进画布拖拽态
      _continentCityPopover(city, e);
    });
    const ends = city.reps.map(r => r.itemId);
    el.addEventListener('mouseenter', () => _continentHighlightNodes(ends, true));
    el.addEventListener('mouseleave', () => _continentHighlightNodes(ends, false));
    world.appendChild(el);
  });

  // ---------- 连线层：辐条（城市→岛）+ 我的大陆边（实线弧）+ 断桥 ----------
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'continent-links');
  svg.setAttribute('width', String(layout.worldW));
  svg.setAttribute('height', String(layout.worldH));

  const arcPath = (a, b) => {
    const mid = _continentLinkMid(a, b);
    return { d: 'M ' + a.cx + ' ' + a.cy + ' Q ' + mid.qx + ' ' + mid.qy + ' ' + b.cx + ' ' + b.cy };
  };

  // 辐条：城市 → 该岛代表卡。两端都被节点盖住（SVG 是世界层首个子元素，节点画在它
  // 上面），所以露出来的正好是走廊那一段——「城市连着哪几座岛」一眼可见。
  plan.cities.forEach(city => {
    city.reps.forEach(r => {
      const p = layout.placements[r.itemId];
      if (!p) return;
      const spoke = document.createElementNS(svgNS, 'line');
      spoke.setAttribute('class', 'continent-spoke');
      spoke.setAttribute('x1', String(city.box.cx));
      spoke.setAttribute('y1', String(city.box.cy));
      spoke.setAttribute('x2', String(p.cx));
      spoke.setAttribute('y2', String(p.cy));
      svg.appendChild(spoke);
    });
  });
  const cityCount = plan.cityCount;

  // 我的大陆边（v2 用户落笔）：实线、可点开操作弹层；有备注挂小标签
  (data.userEdges || []).forEach(e => {
    const a = layout.placements[e.fromItem], b = layout.placements[e.toItem];
    if (!a || !b) return;
    const arc = arcPath(a, b);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'continent-user-link');
    path.setAttribute('d', arc.d);
    path.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      _continentEdgePopover(e, ev);
    });
    svg.appendChild(path);
    if (e.label) {
      const label = document.createElement('div');
      label.className = 'continent-user-link-label';
      // 落点走纯函数（贝塞尔中点）：见 _continentEdgeLabelPos 的注释——曾经这里读
      // arcPath 没返回的 arc.qx，算成 NaNpx 让标签飘到世界层左上角
      const pos = _continentEdgeLabelPos(a, b);
      label.style.left = pos.x + 'px';
      label.style.top = pos.y + 'px';
      label.textContent = e.label;
      label.title = '我的大陆边：' + e.label;
      label.addEventListener('pointerdown', ev => {
        ev.stopPropagation();
        _continentEdgePopover(e, ev);
      });
      world.appendChild(label);
    }
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
      svg.appendChild(p);
    };
    seg(0, 0.55); seg(0.68, 0.8);  // 中段留空 = 桥断了
    const mark = document.createElement('div');
    mark.className = 'continent-dangle-mark';
    mark.style.left = (anchor.cx + ux * len * 0.615) + 'px';
    mark.style.top = (anchor.cy + uy * len * 0.615) + 'px';
    mark.textContent = '✕';
    mark.title = '这条大陆边的一端已不在大陆上（画布被清空或概念被删除），可用工具条「清理断线」移除';
    world.appendChild(mark);
  });

  world.insertBefore(svg, world.firstChild);

  const mineCount = (data.userEdges || []).length;
  const stats = document.getElementById('continentStats');
  if (stats) stats.textContent =
    data.clusterCount + ' 个区域 · ' + data.itemCount + ' 个概念' +
    (cityCount ? ' · ' + cityCount + ' 座边界城市' : '') +
    (plan.folded.length ? ' · 折叠 ' + plan.folded.length + ' 条' : '') +
    (mineCount ? ' · 我的连线 ' + mineCount : '');
  const empty = document.getElementById('continentEmpty');
  if (empty) empty.hidden = (data.itemCount || 0) > 0;
  // 空态引导（v5.4 + 空画布说明）：两句话各自独立成立，用「；」拼进同一条引导——
  // 「暂无共享连线」管「有岛但 0 城市」；「N 个画布还没有知识点」管「画布为什么
  // 不在大陆上」（不以上图内容为前提：只有一个空画布时大字提示之外顶栏也要教机制）。
  // 与连接模式提示互斥的约定不变（见 _continentSetLinkMode）。
  const guide = document.getElementById('continentGuide');
  if (guide) {
    const parts = [];
    if (cityCount === 0 && (data.itemCount || 0) > 0) {
      parts.push('暂无共享连线——同一个概念在第二座岛出现时，这里会自动亮起边界城市');
    }
    const emptyCount = _continentEmptyCanvasCount(
      (typeof window !== 'undefined' && typeof window.getAllSessions === 'function')
        ? window.getAllSessions() : [],
      (data.clusters || []).map(c => c.sessionId));
    if (emptyCount > 0) {
      parts.push('有 ' + emptyCount + ' 个画布还没有知识点，暂时不会出现在大陆上，学出知识点后这里会长出岛');
    }
    _continentGuideText = parts.join('；');
    guide.hidden = !_continentGuideText;
    guide.textContent = _continentGuideText;
  }
  // v5.6：备注标签挂在世界层里，会随地图缩放一起变形——渲染完成后按当前倍率抵消一次
  _continentSyncEdgeLabels();
  return layout;
}

function _continentHighlightNodes(ids, on) {
  (ids || []).forEach(id => {
    const el = _continentNodeEl(id);
    if (el && el.classList) el.classList.toggle('is-hot', !!on);
  });
}

function _continentHighlightPair(a, b, on) {
  _continentHighlightNodes([a, b], on);
}

// ---------- 弹层（单例）：共享概念详情 / 我的边操作 ----------
function _continentClosePopover() {
  // v5.3：在途的「问 Φ」判断没处落了，随弹层关闭一并中止
  if (_continentPhiInflight.size) {
    _continentPhiInflight.forEach(c => { try { c.abort(); } catch (e) { /* 容忍 */ } });
    _continentPhiInflight.clear();
  }
  if (_continentPopover && _continentPopover.remove) _continentPopover.remove();
  _continentPopover = null;
}

function _continentOpenPopover(html, x, y) {
  _continentClosePopover();
  const layer = document.getElementById('continentLayer');
  if (!layer) return null;
  const el = document.createElement('div');
  el.className = 'continent-popover aurora-glass aurora-glass--dialog';
  el.innerHTML = html;
  el.addEventListener('pointerdown', e => e.stopPropagation());  // 场外关闭靠 document 捕获
  layer.appendChild(el);
  const vw = layer.clientWidth || 900, vh = layer.clientHeight || 600;
  const w = el.offsetWidth || 220, h = el.offsetHeight || 120;
  el.style.left = Math.max(8, Math.min(x + 12, vw - w - 8)) + 'px';
  el.style.top = Math.max(64, Math.min(y - h / 2, vh - h - 8)) + 'px';
  _continentPopover = el;
  return el;
}

// v3 确认落笔口：Φ 只会口头建议「去大陆连接」；真正写边在这里，用户亲手点按钮。
// v4：一枚标签可能对应多条链路（同词跨 N 会话），所以按链路逐行列出、逐行落笔。
function _continentSharedPopover(s, ev) {
  const idx = _continentItemIndex();
  const links = (s.links || []).slice(0, 6);
  const userEdges = (_continentData && _continentData.userEdges) || [];
  const rows = links.map((link, i) => {
    const fromTitle = idx.items[link.from] || '（概念已不在）';
    const toTitle = idx.items[link.to] || '（概念已不在）';
    const fromCluster = idx.clusterTitles[link.fromSession] || '已删除的画布';
    const toCluster = idx.clusterTitles[link.toSession] || '已删除的画布';
    const already = userEdges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    return '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">「' + _continentEsc(fromCluster) + '」的 ' + _continentEsc(fromTitle) +
      ' ↔ 「' + _continentEsc(toCluster) + '」的 ' + _continentEsc(toTitle) + '</span>' +
      (already
        ? '<span class="continent-pop-note-inline">已连线</span>'
        : '<button class="continent-pop-btn" data-link="' + i + '">画成大陆边</button>') +
      '</div>';
  }).join('');
  const kindText = s.kind === 'formula'
    ? '两边画布的公式共享结构「' + _continentEsc(s.label) + '」'
    : '两边画布的概念标题共享「' + _continentEsc(s.label) + '」';
  const html =
    '<div class="continent-pop-title">' + (s.kind === 'formula' ? '∑ ' : '◈ ') + _continentEsc(s.label) +
    (links.length > 1 ? ' <span class="continent-pop-count">×' + links.length + '</span>' : '') + '</div>' +
    rows +
    '<div class="continent-pop-desc">' + kindText + '——自动检出的共享点不会自动连线，要不要由你落笔。</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-link]').forEach(btn => btn.addEventListener('click', async () => {
    const link = links[Number(btn.getAttribute('data-link'))];
    if (!link) return;
    try {
      const ok = await _continentAddUserEdge(link.from, link.to, s.label);
      if (ok) { _continentClosePopover(); _continentToast('已画上这条大陆边'); }
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
}

// ---------- v5.1 重逢清单：点城市选去哪儿 ----------
// 铁律「跳转不猜」：一座城市连着 N 座岛就有 N 个目标，绝不替用户猜「最近学的」。
// 一岛一行（画布名 + 卡片名 + 学的时间 + 「去看」）；同一座岛有多张卡命中同一概念时
// 全部列出来（缩进次行、各带自己的「去看」）——词面命中是事实，不该被代表卡口径吞掉。
function _continentRelTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  if (typeof formatRelativeTime === 'function') {
    try { return formatRelativeTime(t); } catch (e) { /* 兜底空串 */ }
  }
  return '';
}

// ---------- 空画布说明：大陆只画有知识点的会话，没知识点的画布完全不上图 ----------
// 用户两次被「我的画布为什么不在大陆里」困扰（docs/日志/2026-09-15.md 排查段）——
// 顶栏把机制说清。灰色空岛明确不做（轻量版口径，见任务拆解）。
// 纯函数（无 DOM）：会话记录同时按 id / sessionId 两种标识比对（知识条目存的是
// sess_xxx 形，会话记录两个字段都有），两种标识都命中不了投影簇才算「还没知识点」。
function _continentEmptyCanvasCount(sessionRecords, clusterSessionIds) {
  const onMap = new Set((clusterSessionIds || []).map(s => String(s)));
  let n = 0;
  (sessionRecords || []).forEach(s => {
    if (!s) return;
    const id = String(s.id || '');
    const sid = String(s.sessionId || '');
    if ((!id || !onMap.has(id)) && (!sid || !onMap.has(sid))) n++;
  });
  return n;
}

// ---------- v5.4 岛牌一句话：前 3 个概念名 + 最近更新时间（纯拼接、不调模型） ----------
// 看懂岛是看懂联系的前提。以后接了 descriptor 槽位可升级成真摘要，拼接口径不变。
// rel 注入是为了 smoke 可测（formatRelativeTime 依赖当前时钟）。
function _continentIslandTagline(cluster, rel) {
  const items = (cluster && cluster.items) || [];
  const names = [];
  let latest = 0;
  (items || []).forEach(it => {
    const t = String((it && it.title) || '').trim();
    if (t && names.length < 3) names.push(t);
    const ts = Number(it && it.createdAt) || 0;
    if (ts > latest) latest = ts;
  });
  const when = latest ? (rel || _continentRelTime)(latest) : '';
  if (when) names.push(when);
  return names.join(' · ');
}

// 该岛命中这条共享概念的全部卡（服务端未给 owners 时退回代表卡一张）
function _continentIslandCards(entry, sessionId, fallbackItemId, idx) {
  const owners = (entry && entry.owners) || [];
  const itemSession = (idx && idx.itemSession) || {};
  const mine = owners.filter(iid => itemSession[iid] === sessionId);
  if (!mine.length) return fallbackItemId ? [fallbackItemId] : [];
  const rep = mine.indexOf(fallbackItemId);
  if (rep > 0) { mine.splice(rep, 1); mine.unshift(fallbackItemId); }  // 代表卡排最前（辐条连的就是它）
  return mine;
}

// 重逢清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentReunionRows(city, idx) {
  const items = (idx && idx.items) || {};
  const clusterTitles = (idx && idx.clusterTitles) || {};
  const itemCreated = (idx && idx.itemCreated) || {};
  const rel = (idx && idx.rel) || _continentRelTime;
  const rows = [];
  ((city && city.reps) || []).forEach(r => {
    const sid = r.sessionId;
    const cards = _continentIslandCards(city && city.entry, sid, r.itemId, idx);
    cards.forEach((iid, k) => {
      const when = rel(itemCreated[iid]);
      const head = k === 0
        ? '<span class="continent-pop-place">' + _continentEsc(clusterTitles[sid] || '已删除的画布') + '</span> · '
        : '<span class="continent-pop-sub">同岛还有</span> ';
      rows.push('<div class="continent-pop-row' + (k === 0 ? '' : ' is-sub') + '">' +
        '<span class="continent-pop-row-text">' + head + _continentEsc(items[iid] || '（概念已不在）') +
        (when ? '<span class="continent-pop-when">' + _continentEsc(when) + '</span>' : '') +
        '</span>' +
        '<button class="continent-pop-btn" data-go="' + _continentEsc(sid) + '"' +
        ' data-item="' + _continentEsc(iid) + '">去看</button>' +
        '</div>');
    });
  });
  return rows.join('');
}

function _continentCityPopover(city, ev) {
  const idx = _continentItemIndex();
  const s = (city && city.entry) || {};
  const reps = (city && city.reps) || [];
  const rows = _continentReunionRows(city, idx);
  // 「画成大陆边」= v3 起的用户确认落笔口（Φ 只会口头建议，真要写边得你点）。
  // 一枚芯片 = 一条链路（两块画布的代表卡之间）；已连过的只标「已连线」。
  const links = (s.links || []).slice(0, 6);
  const userEdges = (_continentData && _continentData.userEdges) || [];
  const chips = links.map((link, i) => {
    const already = userEdges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(idx.clusterTitles[link.fromSession] || '已删除的画布');
    const b = _continentEsc(idx.clusterTitles[link.toSession] || '已删除的画布');
    return '<button class="continent-pop-btn is-quiet" data-link="' + i + '"' +
      ' title="把这两块画布的代表卡连成一条我的大陆边">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  const html =
    '<div class="continent-pop-title">' + (s.kind === 'formula' ? '∑ ' : '◈ ') + _continentEsc(s.label || '') +
    '<span class="continent-pop-count">' + reps.length + ' 块画布</span></div>' +
    (rows || '<div class="continent-pop-desc">这座城市的卡片已不在大陆上了。</div>') +
    '<div class="continent-pop-desc">' +
    (s.kind === 'formula'
      ? '这几块画布的公式共享结构「' + _continentEsc(s.label || '') + '」'
      : '这几块画布的概念标题共享「' + _continentEsc(s.label || '') + '」') +
    '——机器检出的共享点不会自动连线。</div>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '');
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-go]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const sid = btn.getAttribute('data-go');
    const iid = btn.getAttribute('data-item');
    _continentClosePopover();
    enterContinentSession(sid, iid);   // 复用下钻转场 + goToKnowledgeNode 直达定位
  }));
  el.querySelectorAll('[data-link]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const link = links[Number(btn.getAttribute('data-link'))];
    if (!link) return;
    try {
      const ok = await _continentAddUserEdge(link.from, link.to, s.label);
      if (ok) { _continentClosePopover(); _continentToast('已画上这条大陆边'); }
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
}

// v4 折叠清单：没画到地图上的那些在这里照报，逐条可确认并亲手落笔。
// 原因口径见 CONTINENT_FOLD_REASON（v5.1 起四种，v5.5 加第五种「已被更具体的城市
// 覆盖」：弱证据 / 覆盖 / 超每对上限 / 超全图上限 / 无位可放）。地图负责概览，
// 清单负责穷尽——谁也不伪装成对方，更不许静默消失。

// ---------- v5.3 问 Φ：机器没把握的，交给 Φ 说一句人话，落笔权永远在用户 ----------
// 通道取舍：走 /api/models/chat 的 stream:false（与知识摘要优化同一口径），模型选
// Φ 助手槽位（graph，未配置回退主模型）——/api/harness 的评审协议是改图导向
// （messages 按评审/扩展/应用四套固定模板组装、输出走操作白名单），没有裸问答口，
// 折叠行的「两条知识点是否真相关」判断用它反而要绕开整套操作协议。
// 提示词、判读、判断块拼装都是纯函数（无 DOM），单独抽出来给 smoke 断言。

// Φ 必须以「值得连：」或「不建议连：」开头——输出契定了，判读才不是猜谜。
// 格式约定在 system 与 user 两条消息里都写（模型对最后一条更敏感）。
function _continentPhiMessages(left, right, label) {
  const lines = [
    '用户在知识大陆的折叠清单里看到一条机器没把握的跨画布联系，请你判断这两条知识点是否真的相关（值得在地图上画一条连线），还是只是字面相撞。',
    '',
    '共享词：' + (label || '（无）'),
    '第一条：' + ((left && left.title) || '（无标题）') + ((left && left.summary) ? '——' + left.summary : ''),
    '第二条：' + ((right && right.title) || '（无标题）') + ((right && right.summary) ? '——' + right.summary : ''),
    '',
    '注意：共享词可能是「表达」「坐标」这类通用词，判断依据是两条知识的实质内容，不是共享词本身。',
    '只输出一行：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。',
  ].join('\n');
  return [
    { role: 'system', content: '你是知识大陆的助手 Φ。只输出一行判断：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。不要输出任何其他内容。' },
    { role: 'user', content: lines },
  ];
}

// 判读：只认第一行的开头两个约定词；判不出给中性档——判读只影响徽标与语气，
// 芯片（用户落笔口）两种档位都照给。
function _continentPhiVerdict(raw) {
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/<[^>]+>/g, ' ').replace(/\*\*/g, '');
  const firstLine = (text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
  let verdict = 'unknown';
  if (firstLine.indexOf('值得连') === 0) verdict = 'worth';
  else if (firstLine.indexOf('不建议连') === 0) verdict = 'not';
  const reason = firstLine.replace(/^[「『"']?(值得连|不建议连)[」』"']?[：:、]?\s*/, '').trim();
  return { verdict: verdict, text: (reason || firstLine).slice(0, 120) };
}

// 判断块 HTML：徽标（三档）+ 理由 + 每条链路一枚「画成大陆边」芯片（已连线只标注）。
// userEdges 由调用方传入（smoke 不依赖模块状态）。
function _continentPhiBlockHtml(entry, verdict, idx, userEdges) {
  const items = (idx && idx.items) || {};
  const edges = userEdges || [];
  const worth = verdict && verdict.verdict === 'worth';
  const not = verdict && verdict.verdict === 'not';
  const badge = worth ? '值得连' : not ? '不建议连' : 'Φ 的判断';
  const links = ((entry && entry.links) || []).slice(0, 6);
  const chips = links.map((link, i) => {
    const already = edges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(items[link.from] || '？');
    const b = _continentEsc(items[link.to] || '？');
    return '<button class="continent-pop-btn is-quiet" data-phi-link="' + i + '"' +
      ' title="把这两条概念连成一条我的大陆边（Ctrl+Z 可撤销）">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  return '<div class="continent-pop-phi">' +
    '<span class="continent-pop-phi-badge' + (worth ? ' is-worth' : '') + (not ? ' is-not' : '') + '">' + badge + '</span> ' +
    '<span class="continent-pop-phi-text">' + _continentEsc((verdict && verdict.text) || '') + '</span>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '') +
    '</div>';
}

// 芯片点击 = 走 v2 既有落笔通道（KV continent_edges）；清单不关——折叠清单是
// 工作清单，用户要连着过好几条，这行就地变「已连线」。绑定按 dataset 防重：
// 新判断块插入后按整个弹层查询绑定，上一块的芯片不能被二次挂 handler。
function _continentBindPhiChips(scope, entry) {
  if (!scope || !scope.querySelectorAll) return;
  const links = ((entry && entry.links) || []).slice(0, 6);
  scope.querySelectorAll('[data-phi-link]').forEach(btn => {
    if (btn.dataset) {
      if (btn.dataset.phiBound) return;
      btn.dataset.phiBound = '1';
    }
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const link = links[Number(btn.getAttribute('data-phi-link'))];
      if (!link) return;
      try {
        const ok = await _continentAddUserEdge(link.from, link.to, entry.label || '');
        if (ok) {
          const span = document.createElement('span');
          span.className = 'continent-pop-note-inline';
          span.textContent = '已连线';
          if (btn.replaceWith) btn.replaceWith(span); else btn.textContent = '已连线';
          _continentToast('已画上这条大陆边（Ctrl+Z 可撤销）');
        }
      } catch (err) {
        _continentToast('保存失败：' + (err && err.message || err));
      }
    });
  });
}

// 单行「问 Φ」：按钮进忙碌态 → /api/models/chat（stream:false）→ 判断块插到该行
// 下方。弹层已换页/关闭时回包静默丢弃（判断没处落）；失败恢复按钮可重问。
async function _continentAskPhi(f, rowIndex, btn) {
  const entry = (f && f.entry) || {};
  const link = (entry.links || [])[0] || {};
  const idx = _continentItemIndex();
  const model = (typeof getActiveModelForRole === 'function')
    ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
  if (!model) { _continentToast('先在「模型设置」里配置主模型，才能问 Φ'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Φ 看着…'; }
  const popover = _continentPopover;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (ctrl) _continentPhiInflight.add(ctrl);
  try {
    const left = { title: idx.items[link.from] || '', summary: idx.itemSummary[link.from] || '' };
    const right = { title: idx.items[link.to] || '', summary: idx.itemSummary[link.to] || '' };
    if (typeof proxyChatWithModel !== 'function') throw new Error('模型代理通道不可用');
    const resp = await proxyChatWithModel(model, {
      messages: _continentPhiMessages(left, right, entry.label || ''),
      stream: false,
    }, ctrl ? ctrl.signal : undefined);
    const data = await resp.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    if (!popover || _continentPopover !== popover) return;  // 弹层已关/换页
    const v = _continentPhiVerdict(raw);
    const row = popover.querySelector ? popover.querySelector('[data-fold="' + rowIndex + '"]') : null;
    const html = _continentPhiBlockHtml(entry, v, idx, (_continentData && _continentData.userEdges) || []);
    if (row && row.insertAdjacentHTML) {
      row.insertAdjacentHTML('afterend', html);
    } else if (popover.insertAdjacentHTML) {
      popover.insertAdjacentHTML('beforeend', html);
    }
    _continentBindPhiChips(popover, entry);
    if (btn) { btn.textContent = 'Φ 已答'; btn.disabled = true; }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    _continentToast('Φ 判断失败：' + (err && err.message || err));
    if (btn) { btn.disabled = false; btn.textContent = '问 Φ'; }
  } finally {
    if (ctrl) _continentPhiInflight.delete(ctrl);
  }
}

// 折叠清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentFoldedRows(folded, idx) {
  const items = (idx && idx.items) || {};
  return (folded || []).map((f, i) => {
    const s = f.entry || {};
    const link = (s.links || [])[0] || {};
    return '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">' + (s.kind === 'formula' ? '∑ ' : '◈ ') + _continentEsc(s.label) +
      ' · ' + _continentEsc(items[link.from] || '？') + ' ↔ ' + _continentEsc(items[link.to] || '？') +
      ' <span class="continent-pop-reason">' + (CONTINENT_FOLD_REASON[f.reason] || '折叠') + '</span></span>' +
      '<button class="continent-pop-btn is-quiet" data-phi="' + i + '" title="让 Φ 判断这两条是否真的相关">问 Φ</button>' +
      '<button class="continent-pop-btn" data-fold="' + i + '">看两边</button>' +
      '</div>';
  }).join('');
}

function _continentFoldedPopover(ev) {
  const idx = _continentItemIndex();
  const folded = _continentFolded || [];
  const rows = _continentFoldedRows(folded, idx);
  const html =
    '<div class="continent-pop-title">折叠 ' + folded.length + ' 条</div>' +
    '<div class="continent-pop-desc">「弱证据」是 2 字共享串（「表达」「坐标」级）与泛后缀，' +
    '单独立不住——但它照旧参与岛屿摆位；「已被更具体的城市覆盖」是这条共享串只出现在' +
    '更具体的那几个概念名中间（如两条「…守恒定律」之间的「量守恒定律」），地图交给更' +
    '具体的那几座城；「超出每对上限」「超出全图上限」是地图已经画满；「无位可放」是岛之间挤不出' +
    '放得下一座城市的位置（城市绝不叠在岛上）。都不上地图，但照报——' +
    '拿不准就「问 Φ」，它给一句人话判断，要不要连仍由你点「画成大陆边」；' +
    '想让弱证据彻底消失，得修那两条标题本身。</div>' +
    rows;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-fold]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const f = folded[Number(btn.getAttribute('data-fold'))];
    if (f && f.entry) _continentSharedPopover(f.entry, ev);
  }));
  el.querySelectorAll('[data-phi]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const rowIndex = Number(btn.getAttribute('data-phi'));
    const f = folded[rowIndex];
    if (f) _continentAskPhi(f, rowIndex, btn);
  }));
}

function _continentEdgePopover(e, ev) {
  const idx = _continentItemIndex();
  const html =
    '<div class="continent-pop-title">我的大陆边' + (e.label ? ' · ' + _continentEsc(e.label) : '') + '</div>' +
    '<div class="continent-pop-line">' + _continentEsc(idx.items[e.fromItem] || '？') +
    ' ↔ ' + _continentEsc(idx.items[e.toItem] || '？') + '</div>' +
    '<div class="continent-pop-actions">' +
      '<button class="continent-pop-btn" data-act="rename">改备注</button>' +
      '<button class="continent-pop-btn is-danger" data-act="remove">删除连线</button>' +
    '</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el) return;
  el.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async () => {
    const act = btn.getAttribute('data-act');
    if (act === 'remove') {
      _continentClosePopover();
      try {
        await _continentRemoveUserEdges([e.id]);
        _continentToast('已删除（Ctrl+Z 可撤销）');
      } catch (err) { _continentToast('删除失败：' + (err && err.message || err)); }
    } else if (act === 'rename') {
      const next = (typeof window.prompt === 'function')
        ? (window.prompt('这条大陆边的备注（可留空）：', e.label || '') || '') : e.label;
      if (next === e.label) return;
      try {
        await _continentRenameUserEdge(e.id, String(next).slice(0, 40));
        _continentClosePopover();
      } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
    }
  }));
}

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
  const data = await _continentFetchData();
  _continentData = data;
  if (_continentOpen) _continentRender(data);  // 布局与边无关，重渲不动视口
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

async function _continentRenameUserEdge(edgeId, label) {
  const edges = _continentEdgeList().map(e =>
    e.id === edgeId ? Object.assign({}, e, { label: label }) : e);
  const before = _continentEdgeList().find(e => e.id === edgeId);
  await _continentCommit(edges, before ? { type: 'rename', id: edgeId, before: before.label || '' } : null);
}

async function _continentUndoEdgeOp() {
  if (!_continentEdgeUndo.length) { _continentToast('没有可撤销的边操作'); return; }
  const op = _continentEdgeUndo.pop();
  _continentUpdateTools();
  try {
    if (op.type === 'add') {
      await _continentCommit(_continentEdgeList().filter(e => e.id !== op.edge.id));
    } else if (op.type === 'rename') {
      const edges = _continentEdgeList().map(e =>
        e.id === op.id ? Object.assign({}, e, { label: op.before }) : e);
      await _continentCommit(edges);
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
      !window.confirm('大陆上有 ' + dangling.length + ' 条连线的一端已不在（画布被清空或概念被删除），确定移除这些断线吗？')) return;
  try {
    await _continentRemoveUserEdges(dangling.map(e => e.id));
    _continentToast('已清理 ' + dangling.length + ' 条断线（Ctrl+Z 可撤销）');
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
    cleanBtn.textContent = n ? '清理断线 ' + n : '清理断线';
  }
  // v4 折叠清单入口：有折叠才有按钮（没有就不占位）
  const weakBtn = document.getElementById('continentWeakBtn');
  if (weakBtn) {
    const n = (_continentFolded || []).length;
    weakBtn.hidden = n === 0;
    weakBtn.textContent = '折叠 ' + n + ' 条';
  }
}

// ---------- 连接模式（v2 画边入口） ----------
function _continentSetLinkMode(on) {
  _continentLinkMode = !!on;
  _continentLinkSource = null;
  const layer = document.getElementById('continentLayer');
  if (layer && layer.classList) layer.classList.toggle('is-linking', _continentLinkMode);
  const btn = document.getElementById('continentLinkBtn');
  if (btn && btn.classList) btn.classList.toggle('active', _continentLinkMode);
  const hint = document.getElementById('continentHint');
  if (hint) {
    hint.hidden = !_continentLinkMode;
    hint.textContent = '连接模式：先点一个概念，再点另一个区域的概念完成连线（Esc 退出）';
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
    if (hint) hint.textContent = '再点另一个区域的概念完成连线（再点自己取消，Esc 退出）';
    return;
  }
  if (_continentLinkSource.itemId === itemId) {
    _continentMarkLinkSource(null);          // 再点自己 = 取消首选
    _continentLinkSource = null;
    return;
  }
  if (_continentLinkSource.sessionId === sessionId) {
    _continentToast('大陆连线要连接两个不同区域的概念');
    return;
  }
  const label = (typeof window.prompt === 'function')
    ? (window.prompt('给这条大陆边写个备注？（可留空，如「同为波动现象」）', '') || '') : '';
  try {
    const ok = await _continentAddUserEdge(_continentLinkSource.itemId, itemId, label);
    if (ok) { _continentSetLinkMode(false); _continentToast('已连线（Ctrl+Z 可撤销）'); }
  } catch (err) {
    _continentToast('连线保存失败：' + (err && err.message || err));
  }
}

// ---------- 视口：平移缩放（缩放锚点保持光标下的世界点不动） ----------
// v5.6 备注标签「固定字号」：标签在世界层里，会随地图缩放一起放大缩小（2.5 倍时 10px
// 变 25px）。乘 1/zoom 抵消即可当路牌用——缩放只该改变地图，不该改变文字大小。
// 纯函数：夹在 [0.4, 4] 防极端倍率把字缩没或撑爆。
function _continentEdgeLabelScale(zoom) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(4, Math.max(0.4, 1 / z));
}

function _continentSyncEdgeLabels() {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return 0;
  const k = _continentEdgeLabelScale(_continentZoom);
  const labels = world.querySelectorAll('.continent-user-link-label');
  labels.forEach(el => {
    if (el && el.style) el.style.transform = 'translate(-50%,-50%) scale(' + k + ')';
  });
  return labels.length;
}

function _continentApplyTransform() {
  const world = document.getElementById('continentWorld');
  if (world && world.style) {
    world.style.transform = 'translate(' + _continentPan.x + 'px,' + _continentPan.y + 'px) scale(' + _continentZoom + ')';
  }
  _continentSyncEdgeLabels();
}

function _continentZoomAt(factor, cx, cy) {
  const next = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, _continentZoom * factor));
  const ratio = next / _continentZoom;
  // pan' = c − (c − pan)·ratio：世界点 (c − pan)/zoom 在缩放前后都落在屏幕 c 处
  _continentPan.x = cx - (cx - _continentPan.x) * ratio;
  _continentPan.y = cy - (cy - _continentPan.y) * ratio;
  _continentZoom = next;
  _continentApplyTransform();
}

function _continentCenter() {
  const vp = document.getElementById('continentViewport');
  const w = (vp && typeof vp.clientWidth === 'number' && vp.clientWidth) || 900;
  const h = (vp && typeof vp.clientHeight === 'number' && vp.clientHeight) || 600;
  return { x: w / 2, y: h / 2 };
}

function _continentFitView() {
  const world = document.getElementById('continentWorld');
  if (!world) return;
  const vp = document.getElementById('continentViewport');
  const vw = (vp && typeof vp.clientWidth === 'number' && vp.clientWidth) || 900;
  const vh = (vp && typeof vp.clientHeight === 'number' && vp.clientHeight) || 600;
  // world 尺寸是内联 '1858px' 这样的字符串：Number('1858px') 是 NaN，会让适配永远走
  // 800×600 兜底（地图一开就是放大的半屏，看不到岛之间有没有城市）——必须 parseFloat
  const ww = parseFloat(world.style.width) || 800;
  const wh = parseFloat(world.style.height) || 600;
  _continentZoom = Math.min(CONTINENT_ZOOM_MAX,
    Math.max(CONTINENT_ZOOM_MIN, Math.min(vw / ww, vh / wh) * 0.92));
  _continentPan.x = (vw - ww * _continentZoom) / 2;
  _continentPan.y = (vh - wh * _continentZoom) / 2;
  _continentApplyTransform();
}

function _continentRestoreOrFitView() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CONTINENT_VIEW_KEY) || 'null'); } catch (e) { saved = null; }
  if (saved && typeof saved.zoom === 'number' && saved.pan
      && isFinite(saved.pan.x) && isFinite(saved.pan.y)) {
    _continentZoom = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, saved.zoom));
    _continentPan = { x: saved.pan.x, y: saved.pan.y };
    _continentApplyTransform();
  } else {
    _continentFitView();
  }
}

function _continentPersistView() {
  try {
    localStorage.setItem(CONTINENT_VIEW_KEY,
      JSON.stringify({ pan: { x: _continentPan.x, y: _continentPan.y }, zoom: _continentZoom }));
  } catch (e) { /* 存储不可用就只留在内存，不阻断 */ }
}

function _continentBindViewport(viewport) {
  if (!viewport || !viewport.addEventListener) return;
  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; // 右键留给浏览器原生菜单
    // 记下按下时的目标：setPointerCapture 会把 pointerup 重定目标到 viewport，
    // 那时 e.target 不再是被点的节点——点击判定必须用 down 时的目标
    _continentDragState = {
      x: e.clientX, y: e.clientY, panX: _continentPan.x, panY: _continentPan.y,
      moved: false, target: e.target,
    };
    try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* 容忍 */ }
  });
  viewport.addEventListener('pointermove', e => {
    const st = _continentDragState;
    if (!st) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.moved && Math.abs(dx) + Math.abs(dy) > 5) st.moved = true;
    if (st.moved) {
      _continentPan.x = st.panX + dx;
      _continentPan.y = st.panY + dy;
      _continentApplyTransform();
    }
  });
  viewport.addEventListener('pointerup', e => {
    const st = _continentDragState;
    _continentDragState = null;
    if (!st || st.moved || _continentDrilling) return;
    const el = st.target && st.target.closest
      ? st.target.closest('.continent-node, .continent-cluster') : null;
    if (!el || !el.dataset) return;
    if (el.classList && el.classList.contains('continent-node')) {
      // v2 连接模式：节点点击是选端点，不下钻
      if (_continentLinkMode) { _continentLinkPick(el.dataset.itemId, el.dataset.sessionId); return; }
      enterContinentSession(el.dataset.sessionId, el.dataset.itemId);
    } else {
      if (_continentLinkMode) { _continentToast('连接模式要点概念节点（簇内小卡），点空白或标题可先退出'); return; }
      enterContinentSession(el.dataset.sessionId, '');
    }
  });
  viewport.addEventListener('pointercancel', () => { _continentDragState = null; });
  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    _continentZoomAt(e.deltaY < 0 ? 1.12 : 0.9,
      e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
}

// ---------- 开合与转场 ----------
// 转场统一走「锚点保持不动 + 内联 transition」：不做 CSS 类驱动（类移除时机和
// transition 生效窗口互相打架），层透明度交给 CSS，世界位移缩放全由内联样式驱动。
function _continentAnimateWorld(settle) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.style) { settle(); return; }
  world.style.transition = 'none';
  _continentApplyTransform();
  const kick = () => {
    world.style.transition = 'transform ' + CONTINENT_DIVE_MS + 'ms cubic-bezier(.22,.75,.3,1)';
    settle();
    setTimeout(() => { if (world && world.style) world.style.transition = ''; }, CONTINENT_DIVE_MS + 60);
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(kick));
  } else {
    kick();
  }
}

function _continentWorkspace() { return document.getElementById('graphWorkspace'); }

function _continentUpdateBreadcrumb(data) {
  const bc = document.getElementById('continentBreadcrumb');
  if (!bc) return;
  const has = data && Array.isArray(data.clusters) && data.clusters.length > 0
    && (data.itemCount || 0) > 0;
  bc.hidden = !has;
}

async function openContinentView() {
  const layer = _continentEnsureLayer();
  if (!layer || _continentOpen) return;
  _continentOpen = true;
  layer.classList.remove('continent-diving');
  layer.hidden = false;
  const ws = _continentWorkspace();
  if (ws) ws.classList.add('continent-open');
  _continentKeyHandler = e => {
    if (e.key === 'Escape') {
      if (_continentPopover) { _continentClosePopover(); return; }
      if (_continentLinkMode) { _continentSetLinkMode(false); return; }
      closeContinentView();
    }
    // v2：大陆打开时 Ctrl+Z 只作用于大陆边操作栈，不透传给会话图撤销
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      _continentUndoEdgeOp();
    }
  };
  document.addEventListener('keydown', _continentKeyHandler);

  let data;
  try {
    data = await _continentFetchData();
  } catch (err) {
    closeContinentView();
    if (typeof showToast === 'function') showToast('大陆数据加载失败：' + (err && err.message || err));
    return;
  }
  if (!_continentOpen) return; // 加载途中被关
  _continentData = data;
  _continentRender(data);
  _continentUpdateBreadcrumb(data);
  _continentUpdateTools();
  _continentRestoreOrFitView();

  // 表层转场：世界从 1.14 倍沉到恢复的视口（游戏地图「回来」的落定感）
  layer.classList.add('continent-surfacing');
  const c = _continentCenter();
  _continentZoomAt(CONTINENT_SURFACE_FACTOR, c.x, c.y);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    layer.classList.remove('continent-surfacing');
    _continentAnimateWorld(() => _continentZoomAt(1 / CONTINENT_SURFACE_FACTOR, c.x, c.y));
  }));
}

function closeContinentView() {
  if (!_continentOpen) return; // 未开先关必须幂等
  _continentOpen = false;
  if (!_continentSkipViewPersist) _continentPersistView();
  _continentSkipViewPersist = false;
  _continentSetLinkMode(false);
  _continentClosePopover();
  const layer = document.getElementById('continentLayer');
  if (layer) {
    layer.classList.remove('continent-diving', 'continent-surfacing');
    layer.hidden = true;
  }
  const world = document.getElementById('continentWorld');
  if (world && world.style) world.style.transition = '';
  const ws = _continentWorkspace();
  if (ws) ws.classList.remove('continent-open');
  if (_continentKeyHandler) {
    document.removeEventListener('keydown', _continentKeyHandler);
    _continentKeyHandler = null;
  }
}

// 下钻：镜头向点击处推进（点击的世界点在屏上不动，其余世界向外涌出）→
// 整层切换 → 进会话；概念节点再经 goToKnowledgeNode 直达定位（它自带
// 「切会话 + 定位 + 失败 toast」全流程，这里不复述其职责）。
async function enterContinentSession(sessionId, itemId) {
  if (!sessionId || _continentDrilling) return;
  if (typeof switchToSession !== 'function') { closeContinentView(); return; }
  _continentDrilling = true;
  // 留给回程的「离开时视口」是用户此刻的浏览态——下钻动画会把镜头推到 2.6 倍，
  // 那是跳转动作不是浏览位置，close 时的持久化要跳过，别让它覆盖
  _continentPersistView();
  _continentSkipViewPersist = true;
  const layer = document.getElementById('continentLayer');
  const key = String(itemId || '');
  const focus = key && _continentPlacements[key];
  const rect = !focus
    ? _continentClusterRects.find(r => r.sessionId === sessionId) || null : null;
  const origin = focus || rect;
  if (layer && origin) {
    // 点击处的屏幕坐标：pan + worldPos·zoom——缩放锚点放这里，节点原地不动
    const sx = _continentPan.x + origin.cx * _continentZoom;
    const sy = _continentPan.y + origin.cy * _continentZoom;
    if (layer.classList) layer.classList.add('continent-diving');
    _continentAnimateWorld(() => _continentZoomAt(CONTINENT_DIVE_FACTOR, sx, sy));
    await new Promise(r => setTimeout(r, CONTINENT_DIVE_MS));
  }
  closeContinentView();
  _continentDrilling = false;
  try { await switchToSession(sessionId); } catch (e) { /* 会话切换失败不阻断定位 */ }
  if (key && typeof goToKnowledgeNode === 'function') {
    try { await goToKnowledgeNode(itemId); } catch (e) { /* 定位失败自带 toast */ }
  }
}

window.openContinentView = openContinentView;
window.closeContinentView = closeContinentView;
window.enterContinentSession = enterContinentSession;
window._continentLayoutClusters = _continentLayoutClusters;
// v4/v5.1 画什么的纯函数（无 DOM），smoke 直接断言：弱证据不上图 / 每对与全图上限 /
// 城市选位（不撞岛不撞城）/ 折叠原因可分辨 / 重逢清单行可跳转
window._continentDrawPlan = _continentDrawPlan;
window._continentFoldedRows = _continentFoldedRows;
window._continentReunionRows = _continentReunionRows;
window._continentPlaceCity = _continentPlaceCity;
window._continentCityBox = _continentCityBox;
window._continentFits = _continentFits;
window._continentLinkMid = _continentLinkMid;
window._continentEdgeLabelPos = _continentEdgeLabelPos;
window._continentEdgeLabelScale = _continentEdgeLabelScale;
window._continentSyncEdgeLabels = _continentSyncEdgeLabels;
// v5.2 群岛布局 / v5.3 问 Φ / v5.4 岛牌：纯函数（无 DOM），smoke 直接断言
window._continentKinship = _continentKinship;
window._continentClusterOrder = _continentClusterOrder;
window._continentPhiMessages = _continentPhiMessages;
window._continentPhiVerdict = _continentPhiVerdict;
window._continentPhiBlockHtml = _continentPhiBlockHtml;
window._continentIslandTagline = _continentIslandTagline;
window._continentEmptyCanvasCount = _continentEmptyCanvasCount;

// 预热面包屑：启动后拉一次投影，有内容才亮「‹ 大陆」入口（失败静默——
// 查空是正常路径，不弹错）。?continent=1 直开大陆视图（演示/验收捷径）。
// 沙箱里 setTimeout 是桩，此段只在真浏览器跑。
setTimeout(() => {
  _continentFetchData().then(data => {
    _continentUpdateBreadcrumb(data);
    try {
      if (String(location.search || '').indexOf('continent=1') >= 0) openContinentView();
    } catch (e) { /* location 不可用就忽略 */ }
  }).catch(() => {});
}, 2500);
