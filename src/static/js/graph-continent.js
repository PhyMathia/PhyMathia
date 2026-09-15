// ===== 知识大陆（大陆计划 v1：只读投影 + 游戏式分层下钻）=====
// 主图是投影层：数据全部来自 GET /api/continent（服务端从 knowledge + sessions
// 现算），本文件零写路径——绝不写任何 phymathia_graph_ 会话键，子图（各会话探索
// 网）是唯一事实源，主图随时可重算。
// 交互三层口径（游戏地图模型：层级离散、整层切换，不是连续语义缩放）：
// - 下钻：点簇 / 概念节点 → 镜头向点击处推进（转场动画）→ switchToSession，
//   概念节点再经 goToKnowledgeNode 直达定位（等于点 POI 而非进城门口）；
// - 返回：探索网面包屑「‹ 大陆」→ 恢复离开时的平移缩放视口（回来还在原地）；
// - 视图自身只读：无编辑入口，Esc / 关闭按钮收起；右键留给浏览器原生菜单。

const CONTINENT_VIEW_KEY = 'phymathia_continent_view'; // 视口记忆（非会话键）
const CONTINENT_LINE_LIMIT = 24;      // 与服务端 SHARED_CONCEPT_LIMIT 同口径的二次保险
const CONTINENT_NODE_W = 168;
const CONTINENT_NODE_H = 54;
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

function _continentEsc(text) {
  if (typeof escapeHtml === 'function') return escapeHtml(text);
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  return layer;
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

  // 概念节点（POI）
  (data.clusters || []).forEach(c => (c.items || []).forEach(item => {
    const p = layout.placements[item.itemId];
    if (!p) return;
    const el = document.createElement('div');
    el.className = 'continent-node';
    el.dataset.sessionId = c.sessionId || '';
    el.dataset.itemId = item.itemId;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    let html = '<div class="continent-node-title">' + esc(item.title) + '</div>';
    if (item.formulaPreview) {
      html += '<div class="continent-node-formula">' + esc(item.formulaPreview) + '</div>';
    }
    el.innerHTML = html;
    world.appendChild(el);
  }));

  // 簇间连线（大陆最有价值的内容：跨主题的知识连接）
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'continent-links');
  svg.setAttribute('width', String(layout.worldW));
  svg.setAttribute('height', String(layout.worldH));
  let lineCount = 0;
  (data.shared || []).slice(0, CONTINENT_LINE_LIMIT).forEach(s => {
    (s.links || []).forEach(l => {
      const a = layout.placements[l.from], b = layout.placements[l.to];
      if (!a || !b || lineCount >= CONTINENT_LINE_LIMIT) return;
      lineCount++;
      const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
      // 中点沿法线抬一点成弧线，避免直线穿节点；起终点按坐标排序保证弧向稳定
      const dx = b.cx - a.cx, dy = b.cy - a.cy;
      const len = Math.max(1, Math.hypot(dx, dy));
      const lift = Math.min(60, len * 0.14);
      const qx = mx + (-dy / len) * lift, qy = my + (dx / len) * lift;
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('class', 'continent-link');
      path.setAttribute('d', 'M ' + a.cx + ' ' + a.cy + ' Q ' + qx + ' ' + qy + ' ' + b.cx + ' ' + b.cy);
      svg.appendChild(path);
      const label = document.createElement('div');
      label.className = 'continent-link-label' + (s.kind === 'formula' ? ' is-formula' : '');
      label.style.left = ((a.cx + 2 * qx + b.cx) / 4) + 'px';
      label.style.top = ((a.cy + 2 * qy + b.cy) / 4) + 'px';
      label.textContent = (s.kind === 'formula' ? '∑ ' : '') + (s.label || '');
      world.appendChild(label);
    });
  });
  world.insertBefore(svg, world.firstChild);

  const stats = document.getElementById('continentStats');
  if (stats) stats.textContent =
    data.clusterCount + ' 个区域 · ' + data.itemCount + ' 个概念' +
    (lineCount ? ' · ' + lineCount + ' 条簇间连线' : '');
  const empty = document.getElementById('continentEmpty');
  if (empty) empty.hidden = (data.itemCount || 0) > 0;
  return layout;
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
    if (e.button !== 0) return; // 右键留给浏览器原生菜单：只读视图不建自建菜单
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
      enterContinentSession(el.dataset.sessionId, el.dataset.itemId);
    } else {
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
  _continentKeyHandler = e => { if (e.key === 'Escape') closeContinentView(); };
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
  _continentRender(data);
  _continentUpdateBreadcrumb(data);
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
