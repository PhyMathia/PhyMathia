// ====== 力学与树状自动布局（2026-10-10 自 graph-render.js 拆出，T261 纯搬家）=====
// 含 _savePositions：graph-interact.js 拖拽收尾三处裸调用；autoArrangeGraph 由工具栏/
// 右键菜单触发（window 导出在 graph-workflow.js 尾部块，构建序本文件在其之前）。
// 拖动吸附的尺度（世界坐标，缩放前）：列中线 180px 内吸过去；落点纵向对齐 40px 行槽
const GRAPH_LAYER_SNAP_X = 180;
const GRAPH_LAYER_ROW_STEP = 40;

function _savePositions() {
  _syncGroupMembersByContainment();
  const state = _graphState();
  state.layoutVersion = LAYOUT_VERSION;
  state.positions = state.positions || {};
  state.sizes = state.sizes || {};
  graphView.nodes.forEach(n => {
    state.positions[n.id] = n.pinned && n.fixedX != null ? { x: n.fixedX, y: n.fixedY } : { x: n.x, y: n.y };
    // u=1 只认「用户手动拖过尺寸」这一个信号（_applyPointerDrag 里设置），
    // 绝不由 customHeight 反推——否则历史污染值会被当成用户意图永久冻结。
    // 旧数据无 u 字段 → 全部回到自适应，这是有意的自愈。
    state.sizes[n.id] = {
      w: n.customWidth || n.w || 120,
      h: n.customHeight || n.h || 60,
      u: n.userResized ? 1 : 0,
    };
  });
  state.groups = graphView.groups.map(group => ({ ...group }));
  // custom 节点高度不持久化（除非用户手动拖过）：创建期高度一律为 null，
  // 任何非零值都是「测量值被兜底成 custom」的历史污染——留着就会冻死节点。
  // userResized 标记随 spread 一起持久化，重载后仍能认出手动尺寸。
  state.customNodes = graphView.nodes
    .filter(node => node.messageIndex < 0 && GRAPH_CUSTOM_NODE_KINDS.includes(node.kind))
    .map(node => {
      const copy = { ...node };
      if (!copy.userResized) copy.customHeight = null;
      return copy;
    });
  _saveGraphState(state, { layout: true }); // T219：拖拽/改尺寸收尾的纯布局写，不置修改历史脏标
  if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
}

function _tick() {
  const nodes = graphView.nodes;
  const edges = graphView.edges;
  if (!nodes.length) return 0;
  let totalMove = 0;

  const kRepulse = 9000;
  const kAttract = 0.05;
  const kRadial = 0.006;
  const kCenter = 0.0002;
  const damping = 0.88;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.isRoot) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      const area = Math.max(1, Math.sqrt(((a.w || 120) * (a.h || 60)) * ((b.w || 120) * (b.h || 60))) / 1200);
      const f = kRepulse * Math.max(1, area) / (d * d);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned) { b.vx += fx; b.vy += fy; }
    }
  }

  for (const edge of edges) {
    // 联系箭头是纯视觉标注：不参与力学布局，避免自动整理时把两端节点拉近
    if (edge.link) continue;
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let d = Math.sqrt(dx * dx + dy * dy) || 1;
    const target = edge.type === 'primary' ? 320 : 420;
    const f = (d - target) * kAttract;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }

  for (const n of nodes) {
    if (n.isRoot || n.pinned) continue;
    const targetR = TARGET_R[n.depth] || 1800;
    const ix = targetR * Math.cos(n.targetAngle);
    const iy = targetR * Math.sin(n.targetAngle);
    n.vx += (ix - n.x) * kRadial;
    n.vy += (iy - n.y) * kRadial;
    n.vx -= n.x * kCenter;
    n.vy -= n.y * kCenter;
  }

  const root = nodes.find(n => n.isRoot);
  if (root) { root.vx = 0; root.vy = 0; root.x = 0; root.y = 0; }

  for (const n of nodes) {
    if (n.isRoot) continue;
    if (n.id === graphView.dragNodeId) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    if (n.pinned) {
      n.x = n.fixedX;
      n.y = n.fixedY;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx *= damping;
    n.vy *= damping;
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > 14) { n.vx = (n.vx / speed) * 14; n.vy = (n.vy / speed) * 14; }
    n.x += n.vx;
    n.y += n.vy;
    totalMove += Math.abs(n.vx) + Math.abs(n.vy);
  }
  return totalMove;
}

function _runLayout(needsFit) {
  if (!graphView.nodes.length) return;
  // 120 轮 × O(n²) 两两斥力在单帧内跑完，是打开大画布时首帧冻结的根源。
  // 按节点数压缩迭代上限（总工作量近似守恒），并在整体位移收敛后提前退出——
  // 中小图通常 40~60 轮就已静止；大图宁可布局粗一点，也不能把主线程卡住数秒。
  const n = graphView.nodes.length;
  const maxIter = n > 400 ? 30 : n > 150 ? 60 : MAX_ITERATIONS;
  let stagnant = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const movement = _tick();
    if (movement < n * 0.05) {
      if (++stagnant >= 3) break;
    } else {
      stagnant = 0;
    }
  }
  _updateNodeTransforms();
  _fitAllGroupsToMembers();
  _redrawEdges();
  _savePositions();
  _scheduleGraphLayerBands();
  if (needsFit) fitGraph();
}

function _layoutNodeSize(node) {
  return {
    w: node.w || node.customWidth || 120,
    h: node.h || node.customHeight || 60,
  };
}

// 层级由连线的“父子”结构推导（不信任节点上硬编码的 depth）：
//   · 每个节点认第一条入边为父 → 构成一棵树（森林）；
//   · BFS 深度 = 根到该节点的边数 → 同一深度同一横坐标（x = depth*colGap）；
//   · 纵向用 tidy 中序排名 → 每个分支（如“物理视角 → 追问 → 追问回答 → 追问模块”）
//     占据一条连续纵带，物理的追问与数学的追问各自的走廊互不混杂，并随深度逐级右移。
function _arrangeTreeLayout(nodes, edges, colGap, rowUnit, overrides) {
  if (!nodes.length) return;
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });
  const children = {};
  const parent = {};
  const portOf = {};
  nodes.forEach(n => { children[n.id] = []; });
  edges.forEach((e, ei) => {
    if (e.draft || e.link) return; // 忽略草稿与“联系”横连，避免串层
    const from = byId[e.from];
    const to = byId[e.to];
    if (!from || !to) return;
    if (parent[to.id] == null) { // 每个节点只认第一条入边，保证无环森林
      parent[to.id] = from.id;
      portOf[to.id] = e.fromPort || ei;
    }
  });
  nodes.forEach(n => {
    if (parent[n.id] != null) children[parent[n.id]].push(n.id);
  });

  const parentless = nodes.filter(n => parent[n.id] == null);
  let roots = parentless.filter(n => n.isRoot);
  if (!roots.length) roots = parentless.filter(n => n.kind === 'user');
  if (!roots.length) roots = parentless.slice();

  // BFS 深度
  const depth = {};
  const queue = [];
  roots.forEach(r => { depth[r.id] = 0; queue.push(r.id); });
  while (queue.length) {
    const id = queue.shift();
    (children[id] || []).forEach(cid => {
      if (depth[cid] == null) { depth[cid] = depth[id] + 1; queue.push(cid); }
    });
  }
  let maxDepth = 0;
  nodes.forEach(n => { if (depth[n.id] != null && depth[n.id] > maxDepth) maxDepth = depth[n.id]; });

  // 用户手动拖进的层优先：整理不得把人拖回去（否则「吸附到最近层」等于白做）
  const ov = overrides || {};
  nodes.forEach(n => {
    if (ov[n.id] == null) return;
    const wanted = Number(ov[n.id]);
    if (!Number.isFinite(wanted)) return;
    depth[n.id] = Math.max(0, Math.round(wanted));
    if (depth[n.id] > maxDepth) maxDepth = depth[n.id];
  });

  // tidy 中序排名：叶节点顺序编号，内部节点取子节点排名中点 → 纵向坐标
  const rank = {};
  let leafCounter = 0;
  function visit(id) {
    const kids = (children[id] || []).map(cid => ({ id: cid })).sort((a, b) => {
      const pa = String(portOf[a.id] != null ? portOf[a.id] : a.id);
      const pb = String(portOf[b.id] != null ? portOf[b.id] : b.id);
      const d = pa.localeCompare(pb, undefined, { numeric: true });
      return d || (byId[a.id].timestamp || 0) - (byId[b.id].timestamp || 0);
    });
    if (!kids.length) { rank[id] = leafCounter++; return rank[id]; }
    let lo = Infinity;
    let hi = -Infinity;
    kids.forEach(k => {
      const rk = visit(k.id);
      if (rk < lo) lo = rk;
      if (rk > hi) hi = rk;
    });
    rank[id] = (lo + hi) / 2;
    return rank[id];
  }
  roots.forEach(r => visit(r.id));

  const miscNodes = nodes.filter(n => rank[n.id] == null);
  const totalLeaves = leafCounter || 1;
  const nodeDepthOf = n => (depth[n.id] != null ? depth[n.id] : maxDepth + 1);

  // 自适应列宽：统计每列最大节点宽度，列中心 x 按“前一列最大宽/2 + 本列最大宽/2 + 边距”累进。
  // 小列保持约 colGap(420) 的默认间距；宽模块/巨可视化所在列自动加宽，跨列不再压叠，
  // 且不放大其它列 —— 修掉“巨节点把同簇组框撑大、把相邻游离节点挤进边界”的残留。
  const colMaxW = {};
  nodes.forEach(n => {
    const dd = nodeDepthOf(n);
    const w = _layoutNodeSize(n).w;
    colMaxW[dd] = Math.max(colMaxW[dd] || 0, w);
  });
  const colX = {};
  const cols = Object.keys(colMaxW).map(Number).sort((a, b) => a - b);
  cols.forEach((d, idx) => {
    if (idx === 0) { colX[d] = 0; return; }
    const prevD = cols[idx - 1];
    colX[d] = colX[prevD] + Math.max(colGap, (colMaxW[prevD] || 0) / 2 + (colMaxW[d] || 0) / 2 + 48);
  });

  nodes.forEach(n => {
    if (rank[n.id] == null) return;
    n.x = colX[nodeDepthOf(n)];
    n.y = (rank[n.id] - (totalLeaves - 1) / 2) * rowUnit;
  });
  // 游离/杂散节点（无父边且非主根，或仅被杂散节点引用）→ 最右侧竖排
  if (miscNodes.length) {
    const miscX = colX[maxDepth + 1] || 0;
    miscNodes.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const startY = -((miscNodes.length - 1) / 2) * rowUnit;
    miscNodes.forEach((node, i) => {
      node.x = miscX;
      node.y = startY + i * rowUnit;
    });
  }

  // 同列纵向自适应：同一列（同一 x）成员按 tidy 顺序排列，间距按“半高之和+边距”撑开，
  // 让高模块/大可视化节点只撑开它所在那一列，不放大其它列间距，且保持走廊的纵向顺序。
  _resolveColumnVerticalSpacing(nodes, 48);
}

// 同列节点纵向防重叠：按当前 y 排序（≈tidy 顺序），相邻两节点之间强制满足
// (h_a+h_b)/2 + gap 的垂直间距，迭代至收敛；顺序不变、走廊排序不破坏，仅撑开同列间距。
function _resolveColumnVerticalSpacing(nodes, gap) {
  const cols = {};
  nodes.forEach(n => { const c = Math.round(n.x); (cols[c] = cols[c] || []).push(n); });
  Object.keys(cols).forEach(c => {
    const list = cols[c].slice().sort((a, b) => a.y - b.y);
    if (list.length < 2) return;
    let guard = 0;
    while (guard++ < 100) {
      let moved = false;
      for (let k = 0; k < list.length - 1; k++) {
        const a = list[k];
        const b = list[k + 1];
        const minY = (a.h + b.h) / 2 + gap;
        const dy = b.y - a.y;
        if (dy < minY) {
          const push = (minY - dy) * 0.5;
          a.y -= push;
          b.y += push;
          moved = true;
        }
      }
      if (!moved) break;
    }
  });
}

// 分组：成员保持树状/走廊位置不再重排成网格，整组作为原子矩形交给碰撞处理。
function _groupBlockFor(group) {
  const members = (group.nodeIds || [])
    .map(id => graphView.nodeById[id])
    .filter(node => node && node.kind !== 'draft');
  if (!members.length) return null;
  const bounds = _graphGroupBounds(members.map(m => m.id));
  group.x = bounds.x;
  group.y = bounds.y;
  group.width = bounds.width;
  group.height = bounds.height;
  return {
    cx: bounds.x + bounds.width / 2,
    cy: bounds.y + bounds.height / 2,
    w: bounds.width,
    h: bounds.height,
    group,
    members,
  };
}

// 把自由节点与各分组块合成统一矩形碰撞集（大节点作为普通矩形参与局部让位）。
function _collectLayoutBlocks(freeNodes, groupBlocks) {
  const blocks = [];
  freeNodes.forEach(node => {
    const s = _layoutNodeSize(node);
    blocks.push({
      cx: node.x, cy: node.y, w: s.w, h: s.h,
      move: (dx, dy) => { node.x += dx; node.y += dy; },
    });
  });
  groupBlocks.forEach(gb => {
    blocks.push({
      cx: gb.cx, cy: gb.cy, w: gb.w, h: gb.h,
      move: (dx, dy) => {
        gb.group.x += dx;
        gb.group.y += dy;
        gb.members.forEach(m => { m.x += dx; m.y += dy; });
      },
    });
  });
  return blocks;
}

// 矩形重叠消除：自由节点与分组块一律可推（整理=全面重置，不保留固定），
// 分组之间、大节点与相邻列都不互相压叠；按“局部让位”推开，不放大全局间距。
function _resolveLayoutRectOverlaps(blocks, maxPasses) {
  const gap = 24;
  let pass = 0;
  while (pass < (maxPasses || 80)) {
    let moved = false;
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i];
        const b = blocks[j];
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const minX = (a.w + b.w) / 2 + gap;
        const minY = (a.h + b.h) / 2 + gap;
        const ox = minX - Math.abs(dx);
        const oy = minY - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const sx = dx >= 0 ? 1 : -1;
        const sy = dy >= 0 ? 1 : -1;
        let pushX = 0;
        let pushY = 0;
        if (ox < oy) pushX = ox * 0.5;
        else pushY = oy * 0.5;
        a.cx -= sx * pushX; a.cy -= sy * pushY;
        b.cx += sx * pushX; b.cy += sy * pushY;
        if (a.move) a.move(-sx * pushX, -sy * pushY);
        if (b.move) b.move(sx * pushX, sy * pushY);
        moved = true;
      }
    }
    if (!moved) break;
    pass++;
  }
}

// ====== 层带（2026-11-19）======
// 层＝按连线父子关系推导的对话代数（即横坐标列），纯结构、不带任何语义标签：
// 每层是一条极淡的竖向色带，层与层之间不画框、不画线，只靠明暗交替与留白表达层次。
// 这里只负责「读位置画背景」，不改任何节点坐标；吸附与整理在各自的链路里做。
// 层号覆盖：用户手动拖进某一层后，以用户的意图为准（否则下次整理又把人拉回原层）。
// 存在 state.layerOf[nodeId]＝层号；越界值夹到 [0, maxDepth+1]，免出孤儿列。
const GRAPH_LAYER_BAND_PADX = 56;   // 层带左右呼吸边（px），让位算法（_squeezeLayersRightForNode）同源共用
const GRAPH_LAYER_BAND_MINW = 320;  // 层带最小宽度（px）：单节点层也要有像样的一条
function _graphLayerOverrides() {
  const state = _graphState();
  return (state && state.layerOf) || {};
}

function _graphLayerIndexMap(nodes, edges, overrides) {
  const map = {};
  if (!nodes || !nodes.length) return map;
  const byId = {};
  const children = {};
  const parent = {};
  nodes.forEach(n => { byId[n.id] = n; children[n.id] = []; });
  (edges || []).forEach(e => {
    if (e.draft || e.link) return; // 草稿与联系横连不参与分层（同 _arrangeTreeLayout）
    const from = byId[e.from];
    const to = byId[e.to];
    if (!from || !to) return;
    if (parent[to.id] == null) parent[to.id] = from.id; // 每个节点只认第一条入边，保证无环
  });
  nodes.forEach(n => { if (parent[n.id] != null) children[parent[n.id]].push(n.id); });

  const parentless = nodes.filter(n => parent[n.id] == null);
  let roots = parentless.filter(n => n.isRoot);
  if (!roots.length) roots = parentless.filter(n => n.kind === 'user');
  if (!roots.length) roots = parentless.slice();

  const depth = {};
  const queue = [];
  roots.forEach(r => { depth[r.id] = 0; queue.push(r.id); });
  while (queue.length) {
    const id = queue.shift();
    (children[id] || []).forEach(cid => {
      if (depth[cid] == null) { depth[cid] = depth[id] + 1; queue.push(cid); }
    });
  }
  let maxDepth = 0;
  nodes.forEach(n => { if (depth[n.id] != null && depth[n.id] > maxDepth) maxDepth = depth[n.id]; });
  // 游离节点（无父边且非主根）与整理口径一致：落到最右一层
  nodes.forEach(n => { map[n.id] = depth[n.id] != null ? depth[n.id] : maxDepth + 1; });

  const ov = overrides || {};
  Object.keys(ov).forEach(id => {
    if (map[id] == null) return; // 已删除/不属于本图的节点，忽略残留
    const wanted = Number(ov[id]);
    if (!Number.isFinite(wanted)) return;
    map[id] = Math.max(0, Math.min(maxDepth + 1, Math.round(wanted)));
  });
  return map;
}

// 层锚点：每层当前的「列中心」。取该层成员 x 的中位数（抗离群），
// 拖动中的节点自己要被排除，否则锚点会跟着指针跑。
function _graphLayerAnchors(excludeIds) {
  const nodes = (graphView.nodes || []).filter(n => n.kind !== 'draft');
  if (!nodes.length) return [];
  const layerOf = _graphLayerIndexMap(nodes, graphView.edges || [], _graphLayerOverrides());
  const buckets = {};
  nodes.forEach(n => {
    if (excludeIds && excludeIds.has(n.id)) return;
    const d = layerOf[n.id];
    (buckets[d] = buckets[d] || []).push(n.x);
  });
  return Object.keys(buckets).map(Number).sort((a, b) => a - b).map(depth => {
    const xs = buckets[depth].slice().sort((a, b) => a - b);
    const mid = xs.length >> 1;
    const cx = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    return { depth, cx };
  });
}

// 拖动中的目标层高亮：只给该层加一级提亮，不画线、不加框
function _highlightGraphLayer(depth) {
  const wrap = graphInner && graphInner.querySelector('.graph-layers');
  if (!wrap) return;
  wrap.querySelectorAll('.graph-layer-band').forEach(el => {
    const on = depth != null && Number(el.dataset.layer) === Number(depth);
    if (el.classList.contains('is-target') !== on) el.classList.toggle('is-target', on);
  });
}

// 落点归层：找最近的一列中线，返回对齐后的坐标与层号；
// 超出阈值（或图里根本没有别的层）返回 null —— 视为落在空白，不强行安排。
function _snapGraphNodeToLayer(node, excludeIds) {
  if (!node) return null;
  const anchors = _graphLayerAnchors(excludeIds || new Set([node.id]));
  let best = null;
  for (const a of anchors) {
    const dist = Math.abs(a.cx - node.x);
    if (!best || dist < best.dist) best = { dist, a };
  }
  if (!best || best.dist > GRAPH_LAYER_SNAP_X) return null;
  return {
    x: best.a.cx,
    y: Math.round(node.y / GRAPH_LAYER_ROW_STEP) * GRAPH_LAYER_ROW_STEP,
    depth: best.a.depth,
  };
}

// 层带几何：横向取该层成员的实际包围盒（单节点层也保证有像样的宽度），
// 纵向统一到全图上下界 —— 所有层等高，看起来才像「一层一层」而不是一列列小方块。
function _graphLayerBands() {
  const nodes = (graphView.nodes || []).filter(n => n.kind !== 'draft');
  if (!nodes.length) return [];
  const layerOf = _graphLayerIndexMap(nodes, graphView.edges || [], _graphLayerOverrides());
  const padX = GRAPH_LAYER_BAND_PADX;
  const padY = 96;
  const groups = {};
  nodes.forEach(n => {
    const d = layerOf[n.id];
    const s = _layoutNodeSize(n);
    const g = groups[d] || (groups[d] = { depth: d, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    g.minX = Math.min(g.minX, n.x - s.w / 2);
    g.maxX = Math.max(g.maxX, n.x + s.w / 2);
    g.minY = Math.min(g.minY, n.y - s.h / 2);
    g.maxY = Math.max(g.maxY, n.y + s.h / 2);
  });
  let top = Infinity;
  let bottom = -Infinity;
  Object.keys(groups).forEach(k => {
    top = Math.min(top, groups[k].minY);
    bottom = Math.max(bottom, groups[k].maxY);
  });
  return Object.keys(groups)
    .map(k => groups[k])
    .sort((a, b) => a.depth - b.depth)
    .map(g => {
      const cx = (g.minX + g.maxX) / 2;
      const width = Math.max(GRAPH_LAYER_BAND_MINW, g.maxX - g.minX + padX * 2);
      return {
        depth: g.depth,
        left: Math.round(cx - width / 2),
        top: Math.round(top - padY),
        width: Math.round(width),
        height: Math.round((bottom - top) + padY * 2),
      };
    });
}

function _renderGraphLayerBands() {
  if (!graphInner) return;
  let wrap = graphInner.querySelector('.graph-layers');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'graph-layers';
    wrap.setAttribute('aria-hidden', 'true');
    // 必须是最底层：层带在分组框、连线、节点之下
    graphInner.insertBefore(wrap, graphInner.firstChild);
  }
  wrap.innerHTML = _graphLayerBands().map(b =>
    '<div class="graph-layer-band" data-layer="' + b.depth + '" style="left:' + b.left + 'px;top:' + b.top
    + 'px;width:' + b.width + 'px;height:' + b.height + 'px;"></div>'
  ).join('');
}

// 拖拽/整理会在同一帧里连续改坐标：rAF 合并成一次重建，别每次调用都重排 DOM
let _graphLayerBandsRaf = 0;
function _scheduleGraphLayerBands() {
  if (_graphLayerBandsRaf) return;
  _graphLayerBandsRaf = requestAnimationFrame(() => {
    _graphLayerBandsRaf = 0;
    _renderGraphLayerBands();
  });
}

// ====== 宽节点让位（2026-11-20，用户拍板「只往右推」；当晚按实测重写几何口径）======
// 宽节点松手归层成功后，若它让本层的节点右缘「长宽了」，右侧各层整列同量右移给它让位：
// 只把首个邻层的节点缝补到「正常列距 48＋富余 24」，推多少右侧全体就跟着挪多少（相对间距不变）。
// 窄节点加入（右缘没生长）/ 本来就够宽时不动任何人；墙左边的层绝不推（用户拍板：左侧宁可贴着）。
// 只推 x：列内相对位置、y、层号都不动；钉住节点的 fixedX 同步平移，下次存盘不失忆。
// 组框整块跟挪（成员动框不动会被包含同步踢出组）——与整理时「组是原子块」同口径。
const GRAPH_LAYER_PUSH_MARGIN = 24;  // 让位后首个右邻层比正常列距多留的富余（px）
const GRAPH_LAYER_NODE_GAP = 48;     // 横向正常节点缝（与 _arrangeTreeLayout 列宽公式里的 +48 同档）
const GRAPH_LAYER_SETTLE_GAP = 48;   // 落进列里时与同列邻居保持的纵向缝（与整理 _resolveColumnVerticalSpacing 同档）

// 落点归层后的纵向落座：吸附只对齐列中线与 40px 行槽，落点那一行可能已经站着同列邻居
// （实测两张卡会完全重叠、下面那张整张看不见）。这里只挪被拖的这颗：按到落点的距离
// 依次试每个邻居的上/下沿槽位，取最近的不重叠位；邻居本身一律不动（与「只往右推」同口径：
// 不因为一颗新来的卡去重排别人）。
function _settleNodeIntoLayer(node, depth, layerOf) {
  if (!node || depth == null) return false;
  const size = _layoutNodeSize(node);
  const siblings = (graphView.nodes || []).filter(n => n !== node && n.kind !== 'draft' && layerOf[n.id] === depth);
  if (!siblings.length) return false;
  const overlaps = y => siblings.some(n => {
    const s = _layoutNodeSize(n);
    return Math.abs(n.y - y) < (s.h + size.h) / 2 + GRAPH_LAYER_SETTLE_GAP - 0.5
      && Math.abs(n.x - node.x) < (s.w + size.w) / 2 + GRAPH_LAYER_SETTLE_GAP - 0.5;
  });
  if (!overlaps(node.y)) return false;
  const startY = node.y;
  const cands = [];
  siblings.forEach(n => {
    const s = _layoutNodeSize(n);
    const dy = (s.h + size.h) / 2 + GRAPH_LAYER_SETTLE_GAP;
    cands.push(n.y + dy, n.y - dy);
  });
  cands.sort((a, b) => Math.abs(a - startY) - Math.abs(b - startY));
  const slots = [];
  cands.forEach(y => {
    const base = Math.round(y / GRAPH_LAYER_ROW_STEP) * GRAPH_LAYER_ROW_STEP;
    // 行槽取整可能把候选压回邻居身上：上下各补一档
    [base, base + GRAPH_LAYER_ROW_STEP, base - GRAPH_LAYER_ROW_STEP].forEach(v => slots.push(v));
  });
  for (const y of slots) {
    if (!overlaps(y)) { node.y = y; return true; }
  }
  // 整列都排满（极密）：落到最低一颗下面，至少不再完全重叠
  let bottom = -Infinity;
  let lowest = null;
  siblings.forEach(n => {
    const s = _layoutNodeSize(n);
    const b = n.y + s.h / 2;
    if (b > bottom) { bottom = b; lowest = n; }
  });
  if (lowest) {
    const s = _layoutNodeSize(lowest);
    const y = lowest.y + (s.h + size.h) / 2 + GRAPH_LAYER_SETTLE_GAP;
    node.y = Math.round(y / GRAPH_LAYER_ROW_STEP) * GRAPH_LAYER_ROW_STEP;
    return true;
  }
  return false;
}

// 宽节点让位（2026-11-20，用户拍板「只往右推」；2026-11-20 晚重写几何口径）：
// · 按节点真实边缘算，不按层带：色带左右各 56px 呼吸边，按带算会把空隙多算 112px，
//   再把下游层逐列压到 8px 带缝——实测列距 48 被推成 72/120/120（越推越散）。
// · preX/preW：这颗节点在本次改动前的几何。拖动归层时传它在本层内的起手 x（原本就在
//   这一层），从别层拖入则不传（＝它本来就是新占的空间）。改尺寸时传起始中心与起始宽。
//   不传且本层没有别的成员＝这层原本是空的，没有「被吃掉」的空间，一律不推。
// · 触发：本层节点右缘真的长宽才推（growth>0）。
// · 推移：只把首个右邻层的节点缝补到「正常列距 48＋富余 24」；它被推多少，右侧所有层
//   整块平移同样距离——相对间距不变，不再出现逐列加码的楼梯。旧实现把 growth 算了两遍
//   （wall.right 已含 growth 又加一次），拖入宽 60px 的卡能把右邻列推 156px、留上百像素空走廊。
// · 组框整块跟挪：只挪成员不挪框，松手后 _syncGroupMembersByContainment 会把成员踢出组
//   （实测组被清空）。组里任一成员被推，整组按所需最大位移一起走，框与成员不分家。
function _squeezeLayersRightForNode(node, opts) {
  if (!node || !graphView.nodes || graphView.nodes.length < 2) return;
  const options = opts || {};
  const nodes = graphView.nodes.filter(n => n.kind !== 'draft');
  if (nodes.length < 2) return;
  const layerOf = _graphLayerIndexMap(nodes, graphView.edges || [], _graphLayerOverrides());
  const depth = layerOf[node.id];
  if (depth == null) return;
  const bands = _graphLayerBands();
  const wall = bands.find(b => b.depth === depth);
  if (!wall) return;
  const size = _layoutNodeSize(node);
  const preX = Number.isFinite(options.preX) ? Number(options.preX) : null;
  const preNodeW = Number.isFinite(options.preW) ? Number(options.preW) : size.w;
  const layerNodes = {};
  nodes.forEach(n => { (layerNodes[layerOf[n.id]] = layerNodes[layerOf[n.id]] || []).push(n); });
  // 本层右缘：现役（含这颗）vs 改动前（其它成员 + 这颗的 pre 几何）
  let postRight = -Infinity;
  let preRight = -Infinity;
  (layerNodes[depth] || []).forEach(n => {
    const s = _layoutNodeSize(n);
    postRight = Math.max(postRight, n.x + s.w / 2);
    if (n === node) {
      if (preX != null) preRight = Math.max(preRight, preX + preNodeW / 2);
    } else {
      preRight = Math.max(preRight, n.x + s.w / 2);
    }
  });
  if (!Number.isFinite(preRight)) return; // 本层原本没有别人：没有「被吃掉」的空间
  const growth = postRight - preRight;
  if (growth <= 0) return;
  const rightBands = bands.filter(b => b.depth > depth && b.left > wall.left); // 只推「确实在墙右边」的层
  if (!rightBands.length) return;
  const firstList = layerNodes[rightBands[0].depth] || [];
  if (!firstList.length) return;
  let firstLeft = Infinity;
  firstList.forEach(n => {
    const s = _layoutNodeSize(n);
    firstLeft = Math.min(firstLeft, n.x - s.w / 2);
  });
  const shift = Math.max(0, GRAPH_LAYER_NODE_GAP + GRAPH_LAYER_PUSH_MARGIN - (firstLeft - postRight));
  if (shift <= 0) return; // 本来就够宽：不动任何人
  const nodeShift = {};
  rightBands.forEach(b => {
    (layerNodes[b.depth] || []).forEach(n => { nodeShift[n.id] = shift; });
  });
  if (!Object.keys(nodeShift).length) return;
  // 组框整块走：组可能跨层，只要有一个成员在右移层里，整个组（含框）同量平移，
  // 保持组内相对位置——只挪成员不挪框会被 _syncGroupMembersByContainment 踢出组。
  const groupById = {};
  const groupOf = {};
  (graphView.groups || []).forEach(g => {
    groupById[g.id] = g;
    (g.nodeIds || []).forEach(id => { groupOf[id] = g; });
  });
  const groupShift = {};
  Object.keys(nodeShift).forEach(id => {
    const g = groupOf[id];
    if (g) groupShift[g.id] = Math.max(groupShift[g.id] || 0, nodeShift[id]);
  });
  const moved = {};
  const shifted = [];
  Object.keys(groupShift).forEach(gid => {
    const g = groupById[gid];
    const shift = groupShift[gid];
    if (!g || !shift) return;
    g.x += shift;
    if (typeof _updateGroupElement === 'function') _updateGroupElement(g);
    (g.nodeIds || []).forEach(id => {
      const n = graphView.nodeById[id] || nodes.find(item => item.id === id);
      if (!n) return;
      n.x += shift;
      if (n.pinned && n.fixedX != null) n.fixedX += shift;
      moved[id] = true;
      shifted.push(id);
    });
  });
  nodes.forEach(n => {
    const shift = nodeShift[n.id];
    if (!shift || moved[n.id]) return;
    n.x += shift;
    if (n.pinned && n.fixedX != null) n.fixedX += shift;
    shifted.push(n.id);
  });
  if (!shifted.length) return;
  _updateNodeTransforms(shifted);
  _redrawEdges(); // 被挪的不是被拖节点：松手前最后一次画线不含它们的新位置，这里补齐
}

function autoArrangeGraph(preservePinned) {
  if (!graphView.nodes.length) return;
  _pushGraphUndo(false, { layout: true });
  _measureNodes();
  // 整理 = 全面重置：不保留手动固定/尺寸（保持原有语义）
  graphView.nodes.forEach(node => {
    node.pinned = false;
    node.fixedX = null;
    node.fixedY = null;
  });

  const COL_GAP = 420;   // 默认列间距档，不随大节点放大
  const ROW_STEP = 300;  // 默认行距档

  const groupOf = {};
  (graphView.groups || []).forEach(g => (g.nodeIds || []).forEach(id => { groupOf[id] = g; }));
  const usable = graphView.nodes.filter(node => node.kind !== 'draft');
  const usableIds = new Set(usable.map(n => n.id));

  // 1) 树状层级排布：层级=连线父子深度，追问逐级右移成分支走廊
  //    用户手动拖进别的层的节点按 state.layerOf 落位（层归属优先于自动推导）
  _arrangeTreeLayout(usable, graphView.edges, COL_GAP, ROW_STEP, _graphLayerOverrides());

  // 2) 自由节点 + 分组块 统一矩形碰撞，避免组/大节点/相邻列互相压叠
  const freeNodes = usable.filter(n => !groupOf[n.id]);
  const groups = (graphView.groups || [])
    .filter(g => (g.nodeIds || []).some(id => usableIds.has(id)));
  const groupBlocks = groups.map(g => _groupBlockFor(g)).filter(Boolean);
  const blocks = _collectLayoutBlocks(freeNodes, groupBlocks);
  _resolveLayoutRectOverlaps(blocks, 80);

  // 3) 收尾：解固定、按最终成员重算组边界、落位
  graphView.nodes.forEach(node => {
    node.pinned = false;
    node.fixedX = null;
    node.fixedY = null;
  });
  _fitAllGroupsToMembers();

  const state = _graphState();
  state.layoutVersion = LAYOUT_VERSION;
  state.positions = {};
  state.pinned = {};
  // 组框必须跟着整理落档：重渲（renderGraphCanvas:149）是按存档重建 graphView.groups 的，
  // 只存 positions 会把整理前的旧框当现役框，下一次 _measureNodes 按旧框算成员归属，
  // 成员被整批踢出、旧框里碰巧在的自由节点被整批吞进（2026-10-16 实测复现）。
  state.groups = graphView.groups.map(group => ({ ...group }));
  graphView.nodes.forEach(node => {
    if (node.kind === 'draft') return;
    state.positions[node.id] = { x: node.x, y: node.y };
  });
  _saveGraphState(state, { layout: true }); // T219：自动整理是纯布局写
  if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
  _updateNodeTransforms();
  _redrawEdges();
  _scheduleGraphLayerBands();
  fitGraph();
}
