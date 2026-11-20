// ====== 力学与列式自动布局（2026-10-10 自 graph-render.js 拆出，T261 纯搬家）=====
// 含 _savePositions：graph-interact.js 拖拽收尾三处裸调用；autoArrangeGraph 由工具栏/
// 右键菜单触发（window 导出在 graph-workflow.js 尾部块，构建序本文件在其之前）。
// 列是唯一事实源（2026-11-20 用户拍板）：_graphColumns 给出每列成员/宽度/左缘/中心，
// 整理、层带、落点、建列、尺寸跟随全部只读它。列归属 state.layerOf 与自由标记
// state.freeNodes 都是持久事实；自由节点不算列成员、不被整列重算吸回列心。
const GRAPH_LAYER_ROW_STEP = 40;
const GRAPH_COL_PAD = 40;      // 呼吸边：列宽 = 本列最宽节点 + 左右各 40
const GRAPH_COL_GAP = 32;      // 列缝：列与列紧密排列，不再有 420 下限
const GRAPH_COL_NEW_COL = 120; // 拖到两端外侧超过这个距离才新建列
const GRAPH_COL_MAX = 40;      // 安全上限，防误拖出几十列
const GRAPH_COL_STACK_GAP = 48; // 自动整理：列内相邻卡片的统一纵向缝

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


// ====== 列几何与层带（2026-11-20 重写）======
// 列是唯一事实源：_graphColumns 给出每列的成员/宽度/左缘/中心，整理、层带、落点、
// 建列、尺寸跟随全部只读它。层号 = 结构 BFS 深度 + state.layerOf 覆盖；覆盖值允许
// 负数、超出最大深度、以及两列之间的半层（中间插列），不再夹范围也不取整。
// 层带视觉契约不变：平时 opacity:0，只在拖动命中时淡入；不画框、不写字。
const GRAPH_BAND_PADY = 96;  // 层带纵向呼吸边（全图等高）
function _graphLayerOverrides() {
  const state = _graphState();
  return (state && state.layerOf) || {};
}

// 自由节点表（state.freeNodes）：值为 1 即「不属于任何列，整理/落位都不碰它」。
// 读的时候永远给一个对象，旧存档/查看器缺字段时按「没有自由节点」处理。
function _graphFreeNodeMap() {
  const state = (typeof _graphState === 'function') ? _graphState() : null;
  const map = state && state.freeNodes;
  return (map && typeof map === 'object') ? map : {};
}

// 存盘漏斗的清理口（graph-history-diff.js `_saveGraphState` 调用）：节点删了，
// 它的 layerOf/freeNodes 残留必须跟着走，否则两张表只涨不消。
function _pruneGraphNodeMarks(state) {
  if (!state || typeof state !== 'object') return;
  const nodes = (typeof graphView !== 'undefined' && graphView && Array.isArray(graphView.nodes))
    ? graphView.nodes : null;
  if (!nodes || !nodes.length) return; // 空图/重建中不清理，防把整表误删
  const ids = new Set(nodes.map(n => n.id));
  ['layerOf', 'freeNodes'].forEach(key => {
    const map = state[key];
    if (!map || typeof map !== 'object') return;
    Object.keys(map).forEach(id => { if (!ids.has(id)) delete map[id]; });
  });
}

function _graphLayerIndexMap(nodes, edges, overrides) {
  const map = {};
  if (!nodes || !nodes.length) return map;
  const byId = {};
  const children = {};
  const parent = {};
  nodes.forEach(n => { byId[n.id] = n; children[n.id] = []; });
  (edges || []).forEach(e => {
    if (e.draft || e.link) return; // 草稿与联系横连不参与分层（同列几何口径）
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
  // 自由节点仍参与 BFS（否则它的子节点会丢掉结构深度），但不进列、不算最深层：
  // 它们不是列成员，也不该把无父边的游离节点推到更右一列。
  const free = _graphFreeNodeMap();
  let maxDepth = 0;
  nodes.forEach(n => {
    if (free[n.id]) return;
    if (depth[n.id] != null && depth[n.id] > maxDepth) maxDepth = depth[n.id];
  });
  // 游离节点（无父边且非主根）与整理口径一致：落到最右一层
  nodes.forEach(n => {
    if (free[n.id]) return;
    map[n.id] = depth[n.id] != null ? depth[n.id] : maxDepth + 1;
  });

  const ov = overrides || {};
  Object.keys(ov).forEach(id => {
    if (map[id] == null) return; // 已删除/自由/不属于本图的节点，忽略残留
    const wanted = Number(ov[id]);
    if (!Number.isFinite(wanted)) return;
    // 不再夹到 [0, maxDepth+1]：两端建列/中间插列就靠这些值存在。
    map[id] = wanted;
  });
  return map;
}

// 列清单：唯一事实源。opts 可传 nodes/edges/overrides/layerMap/excludeIds。
// 空层不建列、层号跳号不重编号；列宽只看本列最宽节点，列心按列缝累进。
// 自由节点（state.freeNodes）不算列成员、不影响列宽；拖进列前调用方先摘标记。
function _graphColumns(opts) {
  const options = opts || {};
  const all = options.nodes || graphView.nodes || [];
  const exclude = options.excludeIds;
  const free = _graphFreeNodeMap();
  const nodes = all.filter(n => n && n.kind !== 'draft'
    && !(exclude && exclude.has(n.id)) && !free[n.id]);
  if (!nodes.length) return [];
  const layerMap = options.layerMap || _graphLayerIndexMap(nodes, options.edges || graphView.edges || [], options.overrides || _graphLayerOverrides());
  const buckets = {};
  nodes.forEach(n => {
    const d = layerMap[n.id];
    if (d == null) return;
    (buckets[d] || (buckets[d] = [])).push(n);
  });
  const layers = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  let left = 0;
  return layers.map((layer, index) => {
    const members = buckets[layer];
    let maxW = 0;
    members.forEach(n => { maxW = Math.max(maxW, _layoutNodeSize(n).w); });
    const width = maxW + GRAPH_COL_PAD * 2;
    const col = { layer, members, width, left, cx: left + width / 2, index };
    left += width + GRAPH_COL_GAP;
    return col;
  });
}

// 落点判定（试验台同款）：列框内＝回到该列；两列之间的缝＝在这里插一列（层号取
// 左右层中点，不重编号）；两端外侧超过阈值＝新建列；未到阈值＝归最近列。
// colsAll 含被拖节点（屏幕上看到的列框），colsOther 排除它（判断是否真的拖出整排）。
function _graphColumnTargetForNode(node, opts) {
  if (!node) return null;
  const options = opts || {};
  const excludeIds = options.excludeIds || new Set([node.id]);
  const colsAll = _graphColumns(options);
  if (!colsAll.length) return { layer: 0, newCol: false, dir: null, index: 0, node };
  const colsOther = _graphColumns(Object.assign({}, options, { excludeIds }));
  if (colsOther.length && colsOther.length < GRAPH_COL_MAX) {
    const first = colsOther[0];
    const last = colsOther[colsOther.length - 1];
    if (node.x > last.left + last.width + GRAPH_COL_NEW_COL) {
      return { layer: last.layer + 1, newCol: true, dir: 'right', index: colsAll.length, node };
    }
    if (node.x < first.left - GRAPH_COL_NEW_COL) {
      return { layer: first.layer - 1, newCol: true, dir: 'left', index: 0, node };
    }
  }
  for (let i = 0; i < colsAll.length; i++) {
    const c = colsAll[i];
    if (node.x >= c.left && node.x <= c.left + c.width) {
      return { layer: c.layer, newCol: false, dir: null, index: i, node };
    }
  }
  if (colsAll.length < GRAPH_COL_MAX) {
    for (let k = 0; k < colsAll.length - 1; k++) {
      const leftEdge = colsAll[k].left + colsAll[k].width;
      const rightEdge = colsAll[k + 1].left;
      if (node.x >= leftEdge && node.x <= rightEdge) {
        return { layer: (colsAll[k].layer + colsAll[k + 1].layer) / 2, newCol: true, dir: 'middle', index: k + 1, node };
      }
    }
  }
  let best = colsAll[0];
  let bestDist = Infinity;
  let bestIndex = 0;
  for (let j = 0; j < colsAll.length; j++) {
    const c = colsAll[j];
    const d = node.x < c.left ? c.left - node.x : (node.x > c.left + c.width ? node.x - c.left - c.width : 0);
    if (d < bestDist) { bestDist = d; best = c; bestIndex = j; }
  }
  return { layer: best.layer, newCol: false, dir: null, index: bestIndex, node };
}

// 拖拽落点的归属提交口（2026-11-20 用户拍板）：松手这一下决定卡片属于哪一列，
// 或脱离所有列成为自由节点。归属写进 state.layerOf / state.freeNodes 后立即返回，
// 调用方再统一 _realignGraphColumns 让列成员落回列心（自由节点原地不动）。
//   mode 'single'：沿用单卡判定——框内归列、缝里插列、两端建列
//   mode 'multi' ：只看落点中心落在哪个既有列框内；框外/缝里一律自由（不建新列）
//   forceFree   ：Alt 松手——全部标自由，保留当前坐标
// 返回 { assigned: [{id, layer}], freed: [id] } 供调用方做纵向落座。
function _commitGraphNodeOwnership(nodes, opts) {
  const options = opts || {};
  const list = (nodes || []).filter(Boolean);
  const result = { assigned: [], freed: [] };
  const state = _graphState();
  if (!state || !list.length) return result;
  if (!state.layerOf || typeof state.layerOf !== 'object') state.layerOf = {};
  if (!state.freeNodes || typeof state.freeNodes !== 'object') state.freeNodes = {};
  const cols = options.forceFree ? [] : _graphColumns(); // 落点判定用拖动前的列框
  list.forEach(node => {
    let layer = null;
    if (!options.forceFree) {
      if (options.mode === 'single') {
        const target = _graphColumnTargetForNode(node);
        if (target) layer = target.layer;
      } else {
        const col = cols.find(c => node.x >= c.left && node.x <= c.left + c.width);
        if (col) layer = col.layer;
      }
    }
    if (layer == null) {
      state.freeNodes[node.id] = 1;
      delete state.layerOf[node.id]; // 自由是权威：残留层号会让它被当成列成员
      result.freed.push(node.id);
    } else {
      state.layerOf[node.id] = layer;
      delete state.freeNodes[node.id];
      result.assigned.push({ id: node.id, layer });
    }
  });
  return result;
}

// 层带纵向范围：所有列等高，按全图节点上下界各留 96px。
function _graphBandRange(nodes) {
  const list = nodes || (graphView.nodes || []).filter(n => n.kind !== 'draft');
  let top = Infinity;
  let bottom = -Infinity;
  list.forEach(n => {
    const s = _layoutNodeSize(n);
    top = Math.min(top, n.y - s.h / 2);
    bottom = Math.max(bottom, n.y + s.h / 2);
  });
  if (!Number.isFinite(top)) { top = 0; bottom = 0; }
  return { top: Math.round(top - GRAPH_BAND_PADY), height: Math.round(bottom - top + GRAPH_BAND_PADY * 2) };
}

// 层锚点保留旧接口，几何改读列清单（不再取成员 x 中位数）。
function _graphLayerAnchors(excludeIds) {
  return _graphColumns({ excludeIds }).map(c => ({ depth: c.layer, cx: c.cx }));
}

// 列提示 DOM：插列竖线画在节点之上（拖动卡片本身会盖住背景层），新建列的幽灵框同理。
function _graphColumnHintEl(className, create) {
  if (!graphInner || typeof graphInner.querySelector !== 'function') return null;
  let el = graphInner.querySelector('.' + className);
  if (!el && create && typeof document !== 'undefined' && typeof document.createElement === 'function') {
    el = document.createElement('div');
    el.className = className;
    graphInner.appendChild(el);
  }
  return el;
}

// 拖动高亮：落进列框＝该列淡入；落在缝里＝竖线标出插入位置；两端外侧＝幽灵列框。
function _highlightGraphColumnTarget(target) {
  if (!graphInner || typeof graphInner.querySelector !== 'function') return;
  const wrap = graphInner.querySelector('.graph-layers');
  if (!wrap || typeof wrap.querySelectorAll !== 'function') return;
  wrap.querySelectorAll('.graph-layer-band').forEach(el => {
    const on = !!target && !target.newCol && Number(el.dataset.layer) === Number(target.layer);
    if (el.classList.contains('is-target') !== on) el.classList.toggle('is-target', on);
  });
  const insertOn = !!target && !!target.newCol && target.dir === 'middle';
  const ghostOn = !!target && !!target.newCol && target.dir !== 'middle';
  const insert = _graphColumnHintEl('graph-col-insert', insertOn);
  const ghost = _graphColumnHintEl('graph-col-ghost', ghostOn);
  if (insert) {
    if (!insertOn) insert.style.display = 'none';
    else {
      const cols = _graphColumns();
      const leftCol = cols[target.index - 1];
      const rightCol = cols[target.index];
      if (leftCol && rightCol) {
        const range = _graphBandRange();
        insert.style.display = 'block';
        insert.style.left = (leftCol.left + leftCol.width + GRAPH_COL_GAP / 2) + 'px';
        insert.style.top = range.top + 'px';
        insert.style.height = range.height + 'px';
      }
    }
  }
  if (ghost) {
    if (!ghostOn) ghost.style.display = 'none';
    else {
      const cols = _graphColumns();
      const range = _graphBandRange();
      const w = (target.node ? _layoutNodeSize(target.node).w : 240) + GRAPH_COL_PAD * 2;
      let left;
      if (!cols.length) left = (target.node ? target.node.x : 0) - w / 2;
      else if (target.dir === 'right') {
        const last = cols[cols.length - 1];
        left = last.left + last.width + GRAPH_COL_GAP;
      } else {
        left = cols[0].left - GRAPH_COL_GAP - w;
      }
      ghost.style.display = 'block';
      ghost.style.left = left + 'px';
      ghost.style.top = range.top + 'px';
      ghost.style.width = w + 'px';
      ghost.style.height = range.height + 'px';
    }
  }
}

// 旧接口只保留给外部调用：清掉插列提示，仍然按层号淡入目标列。
function _highlightGraphLayer(depth) {
  _highlightGraphColumnTarget(depth == null ? null : { layer: depth, newCol: false });
}

// 归层旧接口：内部改用列框/列缝判定，返回列心与行槽对齐后的坐标。
function _snapGraphNodeToLayer(node, excludeIds) {
  if (!node) return null;
  const target = _graphColumnTargetForNode(node, { excludeIds: excludeIds || new Set([node.id]) });
  if (!target) return null;
  const col = _graphColumns().find(c => c.layer === target.layer);
  return {
    x: col ? col.cx : node.x,
    y: Math.round(node.y / GRAPH_LAYER_ROW_STEP) * GRAPH_LAYER_ROW_STEP,
    depth: target.layer,
    target,
  };
}

// 层带几何直接读列清单：左缘/宽度＝列左缘/列宽（呼吸边已在列宽里），纵向全图等高。
function _graphLayerBands(opts) {
  const options = opts || {};
  const nodes = (options.nodes || graphView.nodes || []).filter(n => n.kind !== 'draft');
  if (!nodes.length) return [];
  const cols = _graphColumns(options);
  const range = _graphBandRange(nodes);
  return cols.map(c => ({
    depth: c.layer,
    left: Math.round(c.left),
    top: range.top,
    width: Math.round(c.width),
    height: range.height,
  }));
}

// 把现有节点全部落回各自列心：列宽变了／成员换了／空列消失后都走这条。
// 变宽右移、变窄回移；组框按成员重算边界，钉住节点同步 fixedX，补画线。
// passive 调用（尺寸测量）在拖拽期间不抢节点位置，调用方可传 force:true 强制。
function _realignGraphColumns(opts) {
  const options = opts || {};
  const cols = _graphColumns(options);
  if (!options.force && (graphView.dragNodeId || graphView.dragGroupId)) return { cols, moved: [] };
  const moved = [];
  cols.forEach(c => c.members.forEach(n => {
    const delta = c.cx - n.x;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
    n.x = c.cx;
    if (n.pinned && n.fixedX != null) n.fixedX = c.cx;
    moved.push(n.id);
  }));
  if (!moved.length) return { cols, moved };
  if (typeof _fitAllGroupsToMembers === 'function') _fitAllGroupsToMembers();
  if (!options.silentUpdate && typeof _updateNodeTransforms === 'function') _updateNodeTransforms(moved);
  if (!options.silentEdges && typeof _redrawEdges === 'function') _redrawEdges();
  return { cols, moved };
}

function _renderGraphLayerBands() {
  if (!graphInner || typeof graphInner.querySelector !== 'function') return;
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

// ====== 落座与尺寸跟随（2026-11-20 重写）======
// 旧的「只往右推」让位已退役：列宽重算天然包含变宽右移与变窄回移，
// _realignGraphColumns 负责整排落位（见上）。这里只留纵向落座常量。
const GRAPH_LAYER_SETTLE_GAP = 48;   // 落进列里时与同列邻居保持的纵向缝（与整理 _resolveColumnVerticalSpacing 同档）

// 落点归层后的纵向落座：吸附只对齐列中线与 40px 行槽，落点那一行可能已经站着同列邻居
// （实测两张卡会完全重叠、下面那张整张看不见）。这里只挪被拖的这颗：按到落点的距离
// 依次试每个邻居的上/下沿槽位，取最近的不重叠位；邻居本身一律不动（与「只往右推」同口径：
// 不因为一颗新来的卡去重排别人）。
function _settleNodeIntoLayer(node, depth, layerOf) {
  if (!node || depth == null) return false;
  const size = _layoutNodeSize(node);
  const free = _graphFreeNodeMap();
  const siblings = (graphView.nodes || []).filter(n => n !== node && n.kind !== 'draft'
    && !free[n.id] && layerOf[n.id] === depth);
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

// 旧名保留为兼容别名：语义已换成「整列重算」——最宽节点变宽右侧右移，
// 变窄或最宽节点换人则整排回移，不再只往右推。新代码直接调 _realignGraphColumns。
function _squeezeLayersRightForNode(node, opts) {
  return _realignGraphColumns({ force: true });
}

function autoArrangeGraph(preservePinned) {
  if (!graphView.nodes.length) return;
  _pushGraphUndo(false, { layout: true });
  _measureNodes();
  const state = _graphState();
  if (!state.layerOf || typeof state.layerOf !== 'object') state.layerOf = {};
  if (!state.freeNodes || typeof state.freeNodes !== 'object') state.freeNodes = {};
  const free = state.freeNodes;

  // 1) 非自由节点按「当前物理列框」归列：框内＝该列，框外＝最近列；不新建列。
  //    用户把卡大致摆好的位置就是顺序事实源，整理只负责把它固化并排整齐。
  //    自由节点（列缝/外侧/Alt 拖出的卡）完全跳过，一根手指都不碰。
  const cols = _graphColumns();
  if (cols.length) {
    const nearest = x => {
      let best = cols[0];
      let bestDist = Infinity;
      cols.forEach(c => {
        const d = x < c.left ? c.left - x : (x > c.left + c.width ? x - c.left - c.width : 0);
        if (d < bestDist) { bestDist = d; best = c; }
      });
      return best;
    };
    graphView.nodes.forEach(node => {
      if (node.kind === 'draft' || free[node.id]) return;
      const inside = cols.find(c => node.x >= c.left && node.x <= c.left + c.width);
      state.layerOf[node.id] = (inside || nearest(node.x)).layer;
    });
  }

  // 2) 只清列成员的钉住：自由节点整理时一动不动，钉不钉住都不影响。
  graphView.nodes.forEach(node => {
    if (node.kind === 'draft' || free[node.id]) return;
    node.pinned = false;
    node.fixedX = null;
    node.fixedY = null;
  });

  // 3) 列几何重算：成员回列心（换列/宽度变化都在这里统一落位）。
  _realignGraphColumns({ force: true, silentUpdate: true, silentEdges: true });

  // 4) 每列按当前 y 排序，统一 48px 缝，整列垂直居中到 y=0。列内上下顺序＝用户摆的顺序，
  //    整理只拉间距、不重排；自由节点不在任何列成员表里，因此不会被卷进来。
  _graphColumns().forEach(col => {
    const members = col.members.slice().sort((a, b) => a.y - b.y);
    if (!members.length) return;
    let total = 0;
    members.forEach(n => { total += _layoutNodeSize(n).h; });
    total += GRAPH_COL_STACK_GAP * (members.length - 1);
    let cursor = -total / 2;
    members.forEach(n => {
      const h = _layoutNodeSize(n).h;
      n.y = Math.round(cursor + h / 2);
      cursor += h + GRAPH_COL_STACK_GAP;
    });
  });

  // 5) 组框按最终成员重算边界（成员换列/换序后框跟着走），绝不在这里增减成员。
  _fitAllGroupsToMembers();

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
    if (node.pinned) state.pinned[node.id] = true;
  });
  _saveGraphState(state, { layout: true }); // T219：自动整理是纯布局写
  if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
  _updateNodeTransforms();
  _redrawEdges();
  _scheduleGraphLayerBands();
  fitGraph();
}
