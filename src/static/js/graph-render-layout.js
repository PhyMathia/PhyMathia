// ====== 力学与树状自动布局（2026-10-10 自 graph-render.js 拆出，T261 纯搬家）=====
// 含 _savePositions：graph-interact.js 拖拽收尾三处裸调用；autoArrangeGraph 由工具栏/
// 右键菜单触发（window 导出在 graph-workflow.js 尾部块，构建序本文件在其之前）。
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
  _saveGraphState(state);
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
function _arrangeTreeLayout(nodes, edges, colGap, rowUnit) {
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
  _arrangeTreeLayout(usable, graphView.edges, COL_GAP, ROW_STEP);

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
  graphView.nodes.forEach(node => {
    if (node.kind === 'draft') return;
    state.positions[node.id] = { x: node.x, y: node.y };
  });
  _saveGraphState(state);
  if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
  _updateNodeTransforms();
  _redrawEdges();
  fitGraph();
}
