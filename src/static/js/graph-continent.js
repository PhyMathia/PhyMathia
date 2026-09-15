// ===== 知识大陆（大陆计划 v1 投影 + v2 簇间边 + v3 边界城市）=====
// 主图是投影层：聚簇与共享概念全部来自 GET /api/continent（服务端从 knowledge +
// sessions 现算），本文件绝不写任何 phymathia_graph_ 会话键——子图（各会话探索
// 网）是唯一事实源，主图随时可重算。
// v2 起主图拥有**自己的**簇间边（KV `continent_edges`，经 /api/kv 读写）：
// 「连接」模式点两个不同区域的概念完成落笔；端点失效的边渲染成断桥，工具条提供
// 清理入口；撤销栈只记边操作（新增/删除/清理/改备注），视口平移缩放不入栈。
// v3 共享概念升级为「边界城市」：端点节点挂徽标皮肤，连线标签可点开弹层，弹层里
// 「画成大陆边」= Φ 口头建议之后的用户确认落笔口（确认才写边）。
// 交互三层口径（游戏地图模型：层级离散、整层切换，不是连续语义缩放）：
// - 下钻：点簇 / 概念节点 → 镜头向点击处推进（转场动画）→ switchToSession，
//   概念节点再经 goToKnowledgeNode 直达定位（等于点 POI 而非进城门口）；
// - 返回：探索网面包屑「‹ 大陆」→ 恢复离开时的平移缩放视口（回来还在原地）；
// - 视图自身克制编辑：只有簇间边一种写路径，Esc / 关闭按钮收起。

const CONTINENT_VIEW_KEY = 'phymathia_continent_view'; // 视口记忆（非会话键）
const CONTINENT_EDGES_API = '/api/kv/continent_edges'; // 主图簇间边的读写端点（现成 KV 通道）
const CONTINENT_LINE_LIMIT = 24;      // 与服务端 SHARED_CONCEPT_LIMIT 同口径的二次保险
// v4 地图减负：同一对区域最多画几条自动连线（其余进清单）；标签竖向错开步长/同列容差
const CONTINENT_PAIR_LINK_LIMIT = 3;
const CONTINENT_LABEL_GAP_Y = 22;
const CONTINENT_LABEL_SPAN_X = 70;
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
let _continentFolded = [];         // v4 折叠清单：[{entry, reason}]（weak=弱证据 / capped=超出每对上限）

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
  const colW = [], rowH = [];
  measured.forEach((m, i) => {
    const ci = i % cols, ri = Math.floor(i / cols);
    colW[ci] = Math.max(colW[ci] || 0, m.w);
    rowH[ri] = Math.max(rowH[ri] || 0, m.h);
  });
  const colX = [], rowY = [];
  let acc = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < colW.length; i++) { colX.push(acc); acc += colW[i] + CONTINENT_CLUSTER_GAP; }
  acc = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < rowH.length; i++) { rowY.push(acc); acc += rowH[i] + CONTINENT_CLUSTER_GAP; }
  const worldW = Math.max(400, acc - CONTINENT_CLUSTER_GAP + CONTINENT_WORLD_MARGIN);
  const worldH = Math.max(300, acc - CONTINENT_CLUSTER_GAP + CONTINENT_WORLD_MARGIN);
  measured.forEach((m, i) => {
    const ci = i % cols, ri = Math.floor(i / cols);
    const x = colX[ci] + (colW[ci] - m.w) / 2;
    const y = rowY[ri] + (rowH[ri] - m.h) / 2;
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
  const items = {}, clusterTitles = {};
  (d.clusters || []).forEach(c => {
    clusterTitles[c.sessionId] = c.title || '未命名画布';
    (c.items || []).forEach(it => { items[it.itemId] = it.title || ''; });
  });
  return { items, clusterTitles };
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
        '<button class="continent-tool is-quiet" id="continentWeakBtn" title="没画到地图上的共享点（弱证据 / 超出每对上限）：照报，可逐条确认落笔" hidden>折叠 0 条</button>' +
        '<button class="continent-tool" id="continentUndoBtn" title="撤销上一条边操作 (Ctrl+Z)" hidden>↩ 撤销</button>' +
        '<button class="continent-tool is-warn" id="continentCleanBtn" title="移除一端已不在大陆上的连线" hidden>清理断线</button>' +
      '</div>' +
      '<span class="continent-hint" id="continentHint" hidden></span>' +
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

// ---------- v4 画什么：强证据 + 每对区域上限 + 标签错开（纯函数，无 DOM 实测） ----------
// 一枚标签 = 一条共享概念（同词跨 N 会话标 ×N），不是每条链路一枚。弱证据不上地图：
// 2 字串（「表达」「坐标」）与泛后缀单独立不住，只进顶栏「弱证据」清单（照报，但不抢视觉）。
function _continentLinkMid(a, b) {
  // 二次贝塞尔（控制点上抬 lift）上 t=0.5 的点：与连线绘制同一公式，标签才落在弧上
  const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const len = Math.max(1, Math.hypot(dx, dy));
  const lift = Math.min(60, len * 0.14);
  const qx = mx + (-dy / len) * lift, qy = my + (dx / len) * lift;
  return { x: (a.cx + 2 * qx + b.cx) / 4, y: (a.cy + 2 * qy + b.cy) / 4, qx, qy };
}

function _continentPlaceLabel(placed, x, y) {
  // 同端点对的标签中点必然重合（同词跨 N 会话 / 端点相同），竖向错开让每一枚都点得到
  let ty = y;
  for (let guard = 0; guard < 12; guard++) {
    const clash = placed.some(p =>
      Math.abs(p.x - x) < CONTINENT_LABEL_SPAN_X && Math.abs(p.y - ty) < CONTINENT_LABEL_GAP_Y);
    if (!clash) break;
    ty += CONTINENT_LABEL_GAP_Y;
  }
  return { x: x, y: ty };
}

function _continentDrawPlan(shared, placements, pairLimit, lineLimit) {
  const items = [], boundary = {}, placed = [], pairs = {}, folded = [];
  let lines = 0;
  (shared || []).slice(0, lineLimit || CONTINENT_LINE_LIMIT).forEach(s => {
    if (s.strength === 'weak') { folded.push({ entry: s, reason: 'weak' }); return; }
    const links = [], total = (s.links || []).length;
    (s.links || []).forEach(l => {
      const a = placements[l.from], b = placements[l.to];
      if (!a || !b || lines >= (lineLimit || CONTINENT_LINE_LIMIT)) return;
      const key = [l.fromSession, l.toSession].sort().join('|');
      const used = pairs[key] || 0;
      if (used >= (pairLimit || CONTINENT_PAIR_LINK_LIMIT)) return;
      pairs[key] = used + 1;
      lines++;
      links.push(l);
    });
    // 一条都画不上（弱证据之外就是被每对上限截光）→ 进折叠清单，不许静默消失
    if (!links.length) { folded.push({ entry: s, reason: 'capped' }); return; }
    let sx = 0, sy = 0, n = 0;
    links.forEach(l => {
      const mid = _continentLinkMid(placements[l.from], placements[l.to]);
      sx += mid.x; sy += mid.y; n++;
      boundary[l.from] = s.label;
      boundary[l.to] = s.label;
    });
    const pos = _continentPlaceLabel(placed, sx / n, sy / n);
    placed.push(pos);
    // total 是**这条共享概念的全部链路数**（含被上限截掉的）：标签上的 ×N 说明
    // 「这条概念在两块画布之外还连着 N 处」，点开弹层逐条看
    items.push({ entry: s, links: links, total: total, x: pos.x, y: pos.y });
  });
  return { items: items, boundary: boundary, lineCount: lines, folded: folded };
}

function _continentEntryEndpoints(planItem) {
  const ids = [];
  (planItem.links || []).forEach(l => {
    if (ids.indexOf(l.from) < 0) ids.push(l.from);
    if (ids.indexOf(l.to) < 0) ids.push(l.to);
  });
  return ids;
}

function _continentRender(data) {
  const world = document.getElementById('continentWorld');
  if (!world) return null;
  world.innerHTML = '';
  const layout = _continentLayoutClusters(data.clusters || []);
  _continentPlacements = layout.placements;
  _continentClusterRects = layout.clusterRects;
  world.style.width = layout.worldW + 'px';
  world.style.height = layout.worldH + 'px';

  const esc = _continentEsc;
  // 边界城市（v3）：共享概念的端点条目 → 概念名 → 共享词。只认**画出来**的那些
  // （强证据且没被每对上限截掉）——弱证据不该把节点标成边界城市。
  const plan = _continentDrawPlan(data.shared || [], layout.placements,
    CONTINENT_PAIR_LINK_LIMIT, CONTINENT_LINE_LIMIT);
  const boundary = plan.boundary;
  _continentFolded = plan.folded;

  // 簇底板（区域图的地皮）
  layout.clusterRects.forEach(rect => {
    const el = document.createElement('div');
    el.className = 'continent-cluster';
    el.dataset.sessionId = rect.sessionId || '';
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    el.innerHTML =
      '<div class="continent-cluster-head">' +
        '<span class="continent-cluster-title">' + esc(rect.title) + '</span>' +
        '<span class="continent-cluster-count">' + rect.itemCount + ' 个概念</span>' +
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

  // ---------- 连线层：自动检出的共享概念（浅色弧线+标签）+ 我的大陆边（实线）+ 断桥 ----------
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'continent-links');
  svg.setAttribute('width', String(layout.worldW));
  svg.setAttribute('height', String(layout.worldH));

  const arcPath = (a, b, liftRatio) => {
    const mid = _continentLinkMid(a, b);
    return { d: 'M ' + a.cx + ' ' + a.cy + ' Q ' + mid.qx + ' ' + mid.qy + ' ' + b.cx + ' ' + b.cy };
  };

  plan.items.forEach(p => {
    p.links.forEach(l => {
      const a = layout.placements[l.from], b = layout.placements[l.to];
      if (!a || !b) return;
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('class', 'continent-link');
      path.setAttribute('d', arcPath(a, b, 0.14).d);
      svg.appendChild(path);
    });
    const s = p.entry;
    const label = document.createElement('div');
    label.className = 'continent-link-label' + (s.kind === 'formula' ? ' is-formula' : '');
    label.style.left = p.x + 'px';
    label.style.top = p.y + 'px';
    label.textContent = (s.kind === 'formula' ? '∑ ' : '◈ ') + (s.label || '') +
      (p.total > 1 ? ' ×' + p.total : '');
    label.title = '共享' + (s.kind === 'formula' ? '公式' : '概念') + '：点开看两边各是哪条';
    // v3 标签可点：弹层看详情 + 「画成大陆边」确认落笔（多链路时每条链路一行）；
    // 悬停点亮所有端点节点
    label.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentSharedPopover(s, e);
    });
    const ends = _continentEntryEndpoints(p);
    label.addEventListener('mouseenter', () => _continentHighlightNodes(ends, true));
    label.addEventListener('mouseleave', () => _continentHighlightNodes(ends, false));
    world.appendChild(label);
  });
  const lineCount = plan.lineCount;

  // 我的大陆边（v2 用户落笔）：实线、可点开操作弹层；有备注挂小标签
  (data.userEdges || []).forEach(e => {
    const a = layout.placements[e.fromItem], b = layout.placements[e.toItem];
    if (!a || !b) return;
    const arc = arcPath(a, b, 0.1);
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
      label.style.left = ((a.cx + 2 * arc.qx + b.cx) / 4) + 'px';
      label.style.top = ((a.cy + 2 * arc.qy + b.cy) / 4) + 'px';
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
    (lineCount ? ' · ' + lineCount + ' 条共享连线' : '') +
    (plan.folded.length ? ' · 折叠 ' + plan.folded.length + ' 条' : '') +
    (mineCount ? ' · 我的连线 ' + mineCount : '');
  const empty = document.getElementById('continentEmpty');
  if (empty) empty.hidden = (data.itemCount || 0) > 0;
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
  if (_continentPopover && _continentPopover.remove) _continentPopover.remove();
  _continentPopover = null;
}

function _continentOpenPopover(html, x, y) {
  _continentClosePopover();
  const layer = document.getElementById('continentLayer');
  if (!layer) return null;
  const el = document.createElement('div');
  el.className = 'continent-popover';
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

// v4 折叠清单：没画到地图上的那些在这里照报，逐条可确认并亲手落笔。
// 两种折叠原因分开标：weak（2 字串/泛后缀，单独立不住）与 capped（同区域对超上限）。
// 地图负责概览，清单负责穷尽——谁也不伪装成对方，更不许静默消失。
const CONTINENT_FOLD_REASON = { weak: '弱证据', capped: '超出每对上限' };

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
    '单独立不住；「超出每对上限」是同一对区域已经画满了。都不上地图，但照报——' +
    '点「看两边」可确认并亲手落笔；想让弱证据彻底消失，得修那两条标题本身。</div>' +
    rows;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-fold]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const f = folded[Number(btn.getAttribute('data-fold'))];
    if (f && f.entry) _continentSharedPopover(f.entry, ev);
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
function _continentApplyTransform() {
  const world = document.getElementById('continentWorld');
  if (world && world.style) {
    world.style.transform = 'translate(' + _continentPan.x + 'px,' + _continentPan.y + 'px) scale(' + _continentZoom + ')';
  }
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
  const ww = Number(world.style.width) || 800;
  const wh = Number(world.style.height) || 600;
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
// v4 画什么的三件套是纯函数（无 DOM），smoke 直接断言：弱证据不上图 / 每对上限 / 标签不重合
window._continentDrawPlan = _continentDrawPlan;
window._continentFoldedRows = _continentFoldedRows;
window._continentPlaceLabel = _continentPlaceLabel;
window._continentLinkMid = _continentLinkMid;

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
