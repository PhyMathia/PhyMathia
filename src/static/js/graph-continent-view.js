// ===== 知识大陆 · 视口与转场（平移缩放/捏合/全屏/warp 转场/开关图与下钻/面包屑/window.* 测试导出）=====
// 自 graph-continent.js 拆出（2026-10-04，T36）。本组最后一个文件：文末 window.* 导出块在加载期立即执行，引用其余五件的全部导出函数，故必须排在最后（build_frontend.mjs entries 顺序即加载顺序）。
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
  // v7.3 渐进披露：细节只切一个 CSS 类（零重建 DOM）——远景档只画海域板+岛牌+城市+航线；
  // 世界档在陆地内部铺词流；区域档加卡片标题；细节档加公式行与锚点短接。一次性全量渲染
  // + CSS 显隐，不动既有 DOM 契约。v8.8 由三档扩到四档，多出来的远景档收掉词流、只留大地名。
  if (world && world.classList) {
    const tier = _continentZoom < CONTINENT_LOD_HORIZON ? 'lod-horizon'
      : _continentZoom < CONTINENT_LOD_WORLD ? 'lod-world'
      : _continentZoom < CONTINENT_LOD_DETAIL ? 'lod-region' : 'lod-detail';
    world.classList.toggle('lod-horizon', tier === 'lod-horizon');
    world.classList.toggle('lod-world', tier === 'lod-world');
    world.classList.toggle('lod-region', tier === 'lod-region');
    world.classList.toggle('lod-detail', tier === 'lod-detail');
    // 词流的反向缩放补偿（推导见 CONTINENT_CLOUD_SCALE_MAX 处）：屏幕字号 = 13px×zoom×k，
    // k 取 1/zoom 于是恒定在 13px 可读档。**带死区**：--cloud-k 写在世界层上，改一次就要
    // 整棵子树重算字号，而滚轮每帧都调这里——0.04 死区把重算从「每帧」压到「每 ~4% 缩放」。
    const k = Math.min(CONTINENT_CLOUD_SCALE_MAX, Math.max(1, 1 / _continentZoom));
    if (Math.abs(k - _continentCloudK) > 0.04) {
      _continentCloudK = k;
      world.style.setProperty('--cloud-k', k.toFixed(2));
    }
  }
  _continentSyncEdgeLabels();
}

// 双指捏合一步（纯函数，T136）：锚点语义与 _continentZoomAt 相同——捏合开始时中点下的
// 世界点 (wx, wy) 钉在当前中点 (mx, my)，间距比 d/d0 驱动缩放并夹在 [MIN, MAX]。
// 两指重叠（d0/d ≤ 0）或任何输入非有限返回 null：调用方保持现状不动——NaN 坐标静默写进
// transform 的老坑（v8.x 教训）不许再踩
function _continentPinchStep(k0, d0, d, wx, wy, mx, my) {
  const args = [k0, d0, d, wx, wy, mx, my];
  if (!args.every(Number.isFinite) || k0 <= 0 || d0 <= 0 || d <= 0) return null;
  let k = k0 * (d / d0);
  if (k < CONTINENT_ZOOM_MIN) k = CONTINENT_ZOOM_MIN;
  if (k > CONTINENT_ZOOM_MAX) k = CONTINENT_ZOOM_MAX;
  return { k: k, x: mx - k * wx, y: my - k * wy };
}

// 捏合锚定（T136）：以两指当下中点/间距/当下变换为基准记锚。进捏合（第二指落下）与
// 三指抬一换对时都调它——锚定「当下」所以零跳变；第一指落下后可能已拖出几像素的平移，
// 也一并折进锚点，不追认也不回退
function _continentPinchAnchor(viewport) {
  const pts = Array.from(_continentPointers.values());
  if (!viewport || !viewport.getBoundingClientRect || pts.length < 2) {
    _continentPinch = null;
    return;
  }
  const rect = viewport.getBoundingClientRect();
  const mx = (pts[0].x + pts[1].x) / 2 - rect.left;
  const my = (pts[0].y + pts[1].y) / 2 - rect.top;
  _continentPinch = {
    d0: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
    k0: _continentZoom,
    wx: (mx - _continentPan.x) / _continentZoom,
    wy: (my - _continentPan.y) / _continentZoom,
  };
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
  // 查阅态：视口是浏览痕迹，跳过落盘（写经账号垫片会进对方命名空间）；拖动/缩放
  // 照常在内存生效，重开大陆按对方保存的视角打开——读对方、写跳过
  if (phyIsReadonly()) { _continentReadonlyNudge(); return; }
  try {
    localStorage.setItem(CONTINENT_VIEW_KEY,
      JSON.stringify({ pan: { x: _continentPan.x, y: _continentPan.y }, zoom: _continentZoom }));
  } catch (e) { /* 存储不可用就只留在内存，不阻断 */ }
}

// T49：浏览器全屏切换（topbar「⤢ 全屏」）。continentLayer 整层提进 top layer，
// 样式层有 .continent-layer:fullscreen 钉满视口；退出路径三条（按钮/Esc/F11）
// 都走 fullscreenchange 统一同步按钮文案，不各自维护状态。
function _continentToggleFullscreen() {
  const layer = document.getElementById('continentLayer');
  if (!layer) return;
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (layer.requestFullscreen) {
      layer.requestFullscreen().catch(() => {});
    } else if (layer.webkitRequestFullscreen) {
      layer.webkitRequestFullscreen();
    }
  } catch (e) { /* 全屏被策略拒绝：静默，按钮仍在 */ }
}

function _continentSyncFullBtn() {
  const btn = document.getElementById('continentFullBtn');
  if (!btn) return;
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  btn.textContent = on ? '⤢ 退出全屏' : '⤢ 全屏';
  btn.title = on ? '退出浏览器全屏（Esc 也行）' : '浏览器全屏显示大陆（再点一次或按 Esc 退出）';
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
    // T136 触屏：登记本指针；第二根落下即进捏合（锚定「当下」，第一指此前可能的
    // 微小平移一并折进锚点），并把拖拽态标成已移动——两指手势的抬指不派发点击
    _continentPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (_continentPointers.size === 2) {
      _continentPinchAnchor(viewport);
      _continentDragState.moved = true;
    }
  });
  viewport.addEventListener('pointermove', e => {
    if (_continentPointers.has(e.pointerId)) {
      _continentPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (_continentPinch && _continentPointers.size >= 2) {
      // 双指捏合（T136）：间距驱动缩放，初始中点下的世界点钉在当前中点（与滚轮同一
      // 锚点语义）。rect 每帧现取，与滚轮分支同一口径——布局可能已变，不能缓存
      const pts = Array.from(_continentPointers.values());
      const rect = viewport.getBoundingClientRect();
      const step = _continentPinchStep(_continentPinch.k0, _continentPinch.d0,
        Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
        _continentPinch.wx, _continentPinch.wy,
        (pts[0].x + pts[1].x) / 2 - rect.left, (pts[0].y + pts[1].y) / 2 - rect.top);
      if (step) {
        _continentZoom = step.k;
        _continentPan.x = step.x;
        _continentPan.y = step.y;
        _continentApplyTransform();
      }
      return; // 捏合期间不走单指平移
    }
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
    _continentPointers.delete(e.pointerId);
    if (_continentPinch) {
      // 捏合中的抬指永不派发点击（两指点按≠点卡片，哪怕全程没动）。收指到一根：
      // 无缝转平移——以剩指当下位置重开拖拽态（moved=true 直进平移不再吃死区）；
      // 还剩两根以上（三指抬一）：换对重锚，同样以当下为基准；全部抬完：清态
      if (_continentPointers.size === 1) {
        _continentPinch = null;
        const rest = _continentPointers.values().next().value;
        _continentDragState = {
          x: rest.x, y: rest.y, panX: _continentPan.x, panY: _continentPan.y,
          moved: true, target: null,
        };
      } else if (_continentPointers.size >= 2) {
        _continentPinchAnchor(viewport);
      } else {
        _continentPinch = null;
        _continentDragState = null;
      }
      return;
    }
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
      // v7.2：连接模式点岛牌 = 岛级航线端点（点两座岛牌也能落笔）；平时点岛牌仍下钻
      if (_continentLinkMode) { _continentLinkPickIsland(el.dataset.sessionId); return; }
      enterContinentSession(el.dataset.sessionId, '');
    }
  });
  viewport.addEventListener('pointercancel', e => {
    // 系统接管手势（来电/通知中心等）：全部清态，不派发点击也不续捏合
    _continentPointers.delete(e.pointerId);
    _continentPinch = null;
    _continentDragState = null;
  });
  // 滚轮缩放合帧（与探索网画布同一口径）：连发 wheel 只累乘系数、记最新锚点，
  // rAF 内重取一次 rect 再缩放——rect 不能在事件里缓存到帧执行时（布局可能已变）
  let _contWheelRaf = 0, _contWheelFactor = 1, _contWheelX = 0, _contWheelY = 0;
  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    _contWheelFactor *= e.deltaY < 0 ? 1.12 : 0.9;
    _contWheelX = e.clientX;
    _contWheelY = e.clientY;
    if (!_contWheelRaf) {
      _contWheelRaf = requestAnimationFrame(() => {
        _contWheelRaf = 0;
        const factor = _contWheelFactor;
        _contWheelFactor = 1;
        const rect = viewport.getBoundingClientRect();
        _continentZoomAt(factor, _contWheelX - rect.left, _contWheelY - rect.top);
      });
    }
  }, { passive: false });
}

// ---------- 开合与转场 ----------
// 跨层转场拆成**两件独立的事**，因为它们的起止时机不一样：
//   1) 交叉淡化（大陆层 ↔ 会话画布）：点下按钮那一刻就能播，两侧都只需要层级的
//      opacity 与画布的 scale，不依赖任何数据。
//   2) 大陆镜头补间（世界层 translate/scale）：**必须等数据**——起点缩放是「目标视口的
//      0.35 倍」，而目标视口要等 _continentRestoreOrFitView() 跑完才知道。
// 暖缓存（实测 0.32s）时两段自然重叠成一段连贯的 420ms；冷启动时是「先拉远、后长出地图」。
//
// 手势沿用本文件原有的「内联 transition + 双 rAF 起跳」，**不走纯 CSS 类驱动**：
// 类增删的时机和 transition 生效窗口互相打架。起点用 transition:none 写死 → 强制重排
// → 再开 transition 写终点，两帧 rAF 只为确保浏览器认得出「起点已经发生过」。
function _continentWarpMs() {
  // T21 收口：以前转场时长是内联写死的 430ms，CSS 里 prefers-reduced-motion 的
  // transition:none !important 压不住内联值，开了「减少动态效果」的用户看到的仍是完整
  // 时长（且下钻会硬等 430ms 才切会话）。时长改从一个函数出，命中就压成 0——状态照翻，
  // 只是不补间。JS 与 CSS 两侧于是都认这个开关。
  try {
    if (typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  } catch (e) { /* 老浏览器没有 matchMedia：按有动效处理 */ }
  return CONTINENT_WARP_MS;
}

function _continentWorkspace() { return document.getElementById('graphWorkspace'); }
function _continentLayerEl() { return document.getElementById('continentLayer'); }
function _continentCanvasEl() { return document.getElementById('graphCanvas'); }

function _continentForcedReflow(el) {
  if (!el) return;
  try { void el.offsetWidth; } catch (e) { /* 沙箱里可能没有布局引擎 */ }
}

// 令牌只能释放一次（setTimeout 兜底与 transitionend 可能都触发，也可能打断路径先来）
function _continentWarpHold() {
  const ws = _continentWorkspace();
  if (ws && ws.classList) ws.classList.add('continent-warp');
  const token = { released: false };
  _continentWarpHoldTok = token;
  return token;
}
function _continentWarpRelease(token) {
  if (!token || token.released) return;
  token.released = true;
  if (_continentWarpHoldTok === token) _continentWarpHoldTok = null;
  const ws = _continentWorkspace();
  if (ws && ws.classList) ws.classList.remove('continent-warp');
}

// 绝对 zoom + 锚点落点。_continentZoomAt 只有相对倍率，跨转场需要直接落到某个绝对值：
// 「从目标视口的 0.35 倍长回去」= 先压到 0.35 倍、绕同一锚点再放回目标。
function _continentSetZoomAt(zoom, cx, cy) {
  const next = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, zoom));
  const ratio = _continentZoom > 0 ? next / _continentZoom : 1;
  _continentPan.x = cx - (cx - _continentPan.x) * ratio;
  _continentPan.y = cy - (cy - _continentPan.y) * ratio;
  _continentZoom = next;
  _continentApplyTransform();
}

// ---- 1) 交叉淡化：大陆层 ↔ 会话画布 ----
// dir='enter' 会话→大陆：会话图缩到 0.5 淡出 + 大陆层淡入（拉远）
// dir='exit'  大陆→会话：大陆层淡出 + 会话图从 0.5 放大到 1 淡入（推近）
// 两方向是严格镜像：同一个类在两个方向扮演相反的起止角色（见下面两个 Apply）。
//
// 画布那一侧走 CSS 类（.is-continent-retreat）而不是内联：.graph-canvas 自身从不写
// inline style（只有内层 .graph-canvas-inner 的 transform 由 _applyGraphTransform 写），
// 所以这里加类不会和会话图自己的缩放互相覆盖。
//
// ⚠️ 三段式（禁过渡→写过渡→写终点）是**规范要求**，不是风格选择：css-transitions-1
// 规定过渡的启动条件是「**变化前**样式里已有该属性的 transition」。先写
// `transition:none` + 起点、下一帧再同时写 `transition:transform 420ms` + 终点，
// 浏览器看到的变化前样式是 none，于是**根本不启动过渡**——表现为一帧硬跳。
// 改这一段之前，进入大陆的「1.14 落定」和下钻的「2.6 推镜」就是这么一直硬跳的
// （用户报的现象正是「立刻切屏，然后放大再缩小」）。中间那次强制重排的作用是让
// 「起点已提交、过渡属性已提交、值还没变」这三个状态分别落地一帧。
function _continentWarpStartState(dir) {
  const layer = _continentLayerEl();
  const canvas = _continentCanvasEl();
  // enter 的起点：大陆层还是透明的，会话图还在自然态
  // exit  的起点：大陆层可见，会话图已经退到 0.5（等下要放大回来）
  if (layer && layer.classList) layer.classList.toggle('continent-warp-fade', dir === 'enter');
  if (canvas && canvas.classList) canvas.classList.toggle('is-continent-retreat', dir === 'exit');
}
function _continentWarpEndState(dir) {
  const layer = _continentLayerEl();
  const canvas = _continentCanvasEl();
  if (layer && layer.classList) layer.classList.toggle('continent-warp-fade', dir === 'exit');
  if (canvas && canvas.classList) canvas.classList.toggle('is-continent-retreat', dir === 'enter');
}

function _continentRunWarp(dir, done) {
  const finish = typeof done === 'function' ? done : () => {};
  const ms = _continentWarpMs();
  const layer = _continentLayerEl();
  const canvas = _continentCanvasEl();
  const ws = _continentWorkspace();

  // 打断在途的那段：直接把它收尾，绝不留半个状态在半路。这是「转场中再按 Esc、
  // 立即跳到目标状态」的收敛保证——任何时刻最多一段转场在跑，且一定收敛到
  // 「大陆开」或「大陆关」二选一。
  if (_continentWarp) {
    const stale = _continentWarp;
    _continentWarp = null;
    _continentClearWarpDom(stale.canvasEl);
    try { stale.finish(); } catch (e) { /* 收尾失败不阻断新转场 */ }
  }
  // 退场时先把藏画布的规则摘掉，否则会话图在整段退场里都是 visibility:hidden，
  // 「放大迎上来」根本看不见。由本函数统一负责，closeContinentView 不再另做。
  if (dir === 'exit' && ws && ws.classList) ws.classList.remove('continent-open');

  const state = { id: ++_continentWarpSeq, dir, canvasEl: canvas, finish };
  _continentWarp = state;

  if (ms <= 0) {
    // 减少动态效果：只翻状态不补间
    _continentWarpEndState(dir);
    _continentWarp = null;
    _continentClearWarpDom(canvas);
    finish();
    return;
  }

  // ① 起点（禁过渡，强制结算）
  _continentWarpStartState(dir);
  _continentForcedReflow(canvas || layer);
  // ② 只写过渡属性，值不动 —— 提交一个「有 transition、值没变」的样式，不会触发过渡
  const trans = 'transform ' + ms + 'ms ' + CONTINENT_WARP_EASE
    + ', opacity ' + ms + 'ms ' + CONTINENT_WARP_EASE;
  if (canvas && canvas.style) canvas.style.transition = trans;
  if (layer && layer.style) layer.style.transition = trans;
  _continentForcedReflow(canvas);
  // ③ 写终点 —— 变化前样式里已有 transition，过渡在这里才真正启动
  _continentWarpEndState(dir);

  // 收尾：transitionend + 定时器双保险。元素被 hidden 时 transitionend 可能不触发，
  // 只挂 transitionend 会把状态永久卡在半路（层藏了但 workspace 还挂着 continent-warp）。
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (_continentWarp !== state) return;
    _continentWarp = null;
    _continentClearWarpDom(canvas);
    finish();
  };
  if (canvas && canvas.addEventListener) {
    canvas.addEventListener('transitionend', settle, { once: true });
    if (layer && layer.addEventListener) layer.addEventListener('transitionend', settle, { once: true });
  }
  setTimeout(settle, ms + 60);
}

// 收干净转场态。三处都要清：画布的类与内联、大陆层的类与内联、workspace 的 continent-warp。
// 漏掉任何一处的后果分别是「会话图永久缩在半屏」「大陆层永远透明」「回归脚本永远等不到
// 转场结束」——所以收尾只走这一个函数，不允许散落。
function _continentClearWarpDom(canvas) {
  if (canvas) {
    if (canvas.style) canvas.style.transition = '';
    if (canvas.classList) canvas.classList.remove('is-continent-retreat');
  }
  const layer = _continentLayerEl();
  if (layer) {
    if (layer.style) layer.style.transition = '';
    if (layer.classList) layer.classList.remove('continent-warp-fade');
  }
  const ws = _continentWorkspace();
  if (ws && ws.classList) ws.classList.remove('continent-warp');
}

// ---- 2) 大陆镜头补间：世界层从 fromZoom 走到 toZoom，锚点 (cx,cy) 原地不动 ----
// 只有一个方向语义：from → to。打开大陆是 from=0.35×目标、to=目标视口（长出来）；
// 下钻是 from=当前、to=更大（推进）。调用方自己算好两端，这里不做倍率推导——
// 早先一版带了个 zoomIn 布尔来分派方向，结果起点终点写反了，世界停在 0.35 倍的远景档，
// 概念卡与边界城市整档 display:none，continent_regression 连挂三条。方向只有一种。
// 同样用三段式启动（见 _continentRunWarp 上面的规范说明）。
function _continentAnimateWorld(fromZoom, toZoom, cx, cy) {
  const world = document.getElementById('continentWorld');
  const ms = _continentWarpMs();
  if (!world || !world.style) { _continentSetZoomAt(toZoom, cx, cy); return; }
  if (ms <= 0) { _continentSetZoomAt(toZoom, cx, cy); return; }
  world.style.transition = 'none';
  _continentSetZoomAt(fromZoom, cx, cy);
  _continentForcedReflow(world);
  world.style.transition = 'transform ' + ms + 'ms ' + CONTINENT_WARP_EASE;
  _continentForcedReflow(world);
  _continentSetZoomAt(toZoom, cx, cy);
  setTimeout(() => { if (world && world.style) world.style.transition = ''; }, ms + 60);
}

// 打开大陆时把「你当前会话对应的那座岛」滚到视口中央；返回 false 让调用方回退到
// 视口中心缩放（没建大陆 / 空数据 / 地图未落笔）。
// 复用 _continentClusterRects —— enterContinentSession 下钻时已经在用同一份数据按
// sessionId 找岛，这里是同一件事的反方向，不需要引入新的 ID 映射。
function _continentFocusSessionIsland(sid) {
  if (!sid) return false;
  const rect = _continentClusterRects.find(r => r && r.sessionId === sid);
  if (!rect || !isFinite(rect.cx) || !isFinite(rect.cy)) return false;
  return _continentFocusWorldPoint(rect.cx, rect.cy);  // 数学同源（T137 抽出）
}


function _continentUpdateBreadcrumb(data) {
  const bc = document.getElementById('continentBreadcrumb');
  if (!bc) return;
  const has = data && Array.isArray(data.clusters) && data.clusters.length > 0
    && (data.itemCount || 0) > 0;
  bc.hidden = !has;
}

async function openContinentView(opts) {
  const layer = _continentEnsureLayer();
  if (!layer || _continentOpen) return;
  _continentOpen = true;
  // 开图路径分两种（v9），靠这个标记区分「从会话打开」与「从面包屑返回」：
  //   返回 → 恢复上次浏览视口（老口径，保住用户离开时的位置）
  //   打开 → 数据到了之后把「你当前会话对应的那座岛」滚到中央（地标连续）
  // 两者在 _continentSettleWorld 里汇合，都走同一段镜头补间。
  // opts.fromBreadcrumb=true 是「‹ 大陆」返回：老口径优先，恢复上次浏览视口。
  // 从会话打开则把当前会话对应的那座岛滚到中央（地标连续）。
  const fromBreadcrumb = !!(opts && opts.fromBreadcrumb);
  const entrySession = typeof window.getCurrentSessionId === 'function'
    ? (window.getCurrentSessionId() || '') : '';
  layer.classList.remove('continent-diving', 'continent-surfacing');
  layer.hidden = false;
  const ws = _continentWorkspace();
  if (ws) ws.classList.add('continent-open');

  // 开图持有一个令牌，第一段（交叉淡化）收尾就释放——v9.1 起没有第二段镜头补间，
  // 「转场在途」就是这 420ms 本身
  const openHold = _continentWarpHold();
  _continentOpenHold = openHold;
  // 交叉淡化立即起播，**不等数据**（smoke 的沙箱里 rAF/setTimeout 是空桩，open 的
  // promise 不能 await 任何靠它们收尾的东西，否则 frontend_smoke 会永不落地）
  _continentRunWarp('enter', () => _continentWarpRelease(openHold));

  _continentKeyHandler = e => {
    if (e.key === 'Escape') {
      // v8 顶栏搜索最先收（有命中=清单开着）：清搜索，不动弹层/连接模式/大陆本身
      if (_continentSearchResults.length) { _continentSearchClear(); return; }
      if (_continentPopover) { _continentClosePopover(); return; }
      if (_continentLinkMode) { _continentSetLinkMode(false); return; }
      closeContinentView();
    }
    // v2：大陆打开时 Ctrl+Z 只作用于航线操作栈，不透传给会话图撤销
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      _continentUndoEdgeOp();
    }
  };
  document.addEventListener('keydown', _continentKeyHandler);

  // T135 加载态：投影没到之前顶栏先给转圈＋文案（_continentRender 到达后整段覆盖）
  const statsEl = document.getElementById('continentStats');
  if (statsEl) statsEl.innerHTML =
    '<span class="continent-loading-spin" aria-hidden="true"></span>正在展开大陆…';
  let data;
  try {
    // v7.1a：海域覆盖（改名/挪岛）先于首次渲染就位——第一次画就是用户纠正过的样子；
    // v7.3：折叠态（收起的岛/海域）同样先就位；v8：纠正记录条数（图例脚注要照报）
    // T135：三路请求互不依赖，并行拉（原串行＝三倍往返白等）；折叠态是本地同步读
    _continentLoadCollapsed();
    const loaded = await Promise.all([
      _continentLoadRegionOverrides(),
      _continentLoadCorrectionCount(),
      _continentFetchData(),
    ]);
    _continentCorrectionCount = loaded[1];
    data = loaded[2];
  } catch (err) {
    // 加载失败：把已经起播的拉远动画反向收回去（大陆缩回没打开的样子），再报错。
    // 不能只 closeContinentView —— 那样会把用户留在「会话已缩没、大陆也没了」的空白里。
    _continentRunWarp('exit');
    if (typeof showToast === 'function') showToast('大陆数据加载失败：' + (err && err.message || err));
    setTimeout(() => {
      if (_continentOpen) closeContinentView();
      else _continentWarpRelease(openHold); // 已被关：close 接手释放，这里只兜底
    }, _continentWarpMs() + 80);
    return;
  }
  if (!_continentOpen) { _continentWarpRelease(openHold); return; } // 加载途中被关
  _continentData = data;
  _continentRender(data);
  _continentUpdateBreadcrumb(data);
  _continentUpdateTools();
  _continentSettleWorld(entrySession, fromBreadcrumb);
}

// 数据到了之后把大陆落到最终视口——**只落位，不补间**（v9.1，见 CONTINENT_WARP_MS
// 上方的注释）。锚点仍是「当前会话对应的那座岛」；从面包屑返回时走老口径恢复视口。
// 内容在这里直接出现：暖缓存下第一段刚好收尾、读起来是一段；冷启动下内容后到、
// 直接出现（那是加载，不是动画）。 continent-warp 已由第一段的 finish 释放，
// 这里不再持有令牌。
function _continentSettleWorld(entrySession, fromBreadcrumb) {
  _continentRestoreOrFitView();
  if (!fromBreadcrumb && entrySession) {
    _continentFocusSessionIsland(entrySession);
  }
}

function closeContinentView() {
  if (!_continentOpen) return; // 未开先关必须幂等
  _continentOpen = false;
  // v7.1b：在途的 Φ 批量归类随大陆关闭中止（已完成的批已落盘，不丢）
  if (_continentGateCtrl) {
    try { _continentGateCtrl.abort(); } catch (e) { /* 容忍 */ }
    _continentGateCtrl = null;
  }
  if (!_continentSkipViewPersist) _continentPersistView();
  _continentSkipViewPersist = false;
  _continentSetLinkMode(false);
  _continentSearchClear();   // v8：搜索态（输入/清单/高亮）不跨开合存活
  _continentClosePopover();
  // v9：layer.hidden 从「同步立刻置位」改成「转场结束后才置」——退场要先看见大陆
  // 淡出、画布放大迎上来，硬切就没有退场动画了。_continentOpen 与上面的清理全部
  // 仍是同步的：smoke 的「未开先关两次幂等」用例同步连调两次 close，不等动画。
  // 藏画布规则的解除交给 _continentRunWarp('exit')（它要在摆起点之前做，
  // 否则会话图整段退场都是 visibility:hidden）
  // 关图接手开图可能还挂着的令牌（数据没到就被关）：否则 continent-warp 永远不摘
  if (_continentOpenHold) { _continentWarpRelease(_continentOpenHold); _continentOpenHold = null; }
  // _continentSkipWarp=true 说明调用方（enterContinentSession）刚播完退场转场，
  // 这里只做收尾不要再播一遍
  if (_continentSkipWarp) {
    _continentClearWarpDom(_continentCanvasEl());
    const l0 = _continentLayerEl();
    if (l0) {
      l0.classList.remove('continent-diving', 'continent-surfacing', 'continent-warp-fade');
      l0.hidden = true;
    }
    const w0 = document.getElementById('continentWorld');
    if (w0 && w0.style) w0.style.transition = '';
    if (_continentKeyHandler) {
      document.removeEventListener('keydown', _continentKeyHandler);
      _continentKeyHandler = null;
    }
    return;
  }
  const closeHold = _continentWarpHold();
  _continentRunWarp('exit', () => {
    const layer = _continentLayerEl();
    if (layer) {
      layer.classList.remove('continent-diving', 'continent-surfacing', 'continent-warp-fade');
      layer.hidden = true;
    }
    const world = document.getElementById('continentWorld');
    if (world && world.style) world.style.transition = '';
    _continentWarpRelease(closeHold);
  });
  if (_continentKeyHandler) {
    document.removeEventListener('keydown', _continentKeyHandler);
    _continentKeyHandler = null;
  }
}

// 下钻：先切到目标会话（会话画布在背后就位），再播「大陆朝点击处推进 + 会话迎面放大」
// 的转场，收尾后经 goToKnowledgeNode 直达定位（它自带「定位 + 失败 toast」全流程，
// 这里不复述其职责）。v9 换了顺序：会话图必须在转场开始前就渲染好，否则放大进来的
// 是上一个会话的图。切换失败要退回大陆——人已经离开了，不能把他留在空白里。
async function enterContinentSession(sessionId, itemId) {
  if (!sessionId || _continentDrilling) return;
  if (typeof switchToSession !== 'function') { closeContinentView(); return; }
  _continentDrilling = true;
  // 留给回程的「离开时视口」是用户此刻的浏览态——下钻动画会把镜头推远，
  // 那是跳转动作不是浏览位置，close 时的持久化要跳过，别让它覆盖
  _continentPersistView();
  _continentSkipViewPersist = true;
  const layer = _continentLayerEl();
  const key = String(itemId || '');
  const focus = key && _continentPlacements[key];
  const rect = !focus
    ? _continentClusterRects.find(r => r.sessionId === sessionId) || null : null;
  const origin = focus || rect;
  let sx = 0, sy = 0, hasAnchor = false;
  if (origin && isFinite(origin.cx) && isFinite(origin.cy)) {
    // 点击处的屏幕坐标：pan + worldPos·zoom——缩放锚点放这里，节点原地不动
    sx = _continentPan.x + origin.cx * _continentZoom;
    sy = _continentPan.y + origin.cy * _continentZoom;
    hasAnchor = true;
  }
  if (!hasAnchor) { const c = _continentCenter(); sx = c.x; sy = c.y; }

  // 先切会话。渲染在背后完成，失败则原地退回大陆（不播转场，用户不感知这次失败）
  try {
    await switchToSession(sessionId);
  } catch (e) {
    if (typeof showToast === 'function') showToast('切换会话失败：' + (e && e.message || e));
    _continentDrilling = false;
    _continentSkipViewPersist = false;
    return; // 大陆仍开着，无需退回
  }

  if (layer && layer.classList) layer.classList.add('continent-diving');
  // 大陆朝锚点推进（被点的岛原地不动、其余向外涌出）——同时会话画布从 0.5 倍迎面放大。
  // 播完再 closeContinentView，但那时转场已经跑完，别让它重播一遍（会看到大陆淡出两次）
  const targetZoom = Math.min(CONTINENT_ZOOM_MAX, _continentZoom * 1.8);
  const drillHold = _continentWarpHold();
  _continentAnimateWorld(_continentZoom, targetZoom, sx, sy);
  _continentRunWarp('exit');
  await new Promise(r => setTimeout(r, _continentWarpMs() + 80));
  _continentSkipWarp = true;
  closeContinentView();
  _continentSkipWarp = false;
  _continentWarpRelease(drillHold);
  _continentDrilling = false;
  if (key && typeof goToKnowledgeNode === 'function') {
    try { await goToKnowledgeNode(itemId); } catch (e) { /* 定位失败自带 toast */ }
  }
}


// 供 continent_regression.mjs 把视口摆到指定会话的岛上：那条用例要点具体节点，
// 不能再依赖「开图入口碰巧落在哪」的副作用（v9 起入口分两种，见 openContinentView）。
// 暴露的是应用自己的同一个算子，不另造一套测试专用逻辑。
window._continentFocusSessionIslandForTest = _continentFocusSessionIsland;
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
window._continentKindPrefix = _continentKindPrefix;
window._continentEdgeLabelScale = _continentEdgeLabelScale;
window._continentSyncEdgeLabels = _continentSyncEdgeLabels;
// v5.2 群岛布局 / v5.3 问 Φ / v5.4 岛牌：纯函数（无 DOM），smoke 直接断言
window._continentKinship = _continentKinship;
window._continentClusterOrder = _continentClusterOrder;
window._continentPhiMessages = _continentPhiMessages;
window._continentPhiVerdict = _continentPhiVerdict;
window._continentPhiBlockHtml = _continentPhiBlockHtml;
window._continentIslandTagline = _continentIslandTagline;
// v7.1a 海域层：纯函数（无 DOM），smoke 直接断言（分组/配色确定性/两级布局罩住海域板）
window._continentRegionHue = _continentRegionHue;
window._continentHueWithOverride = _continentHueWithOverride;   // v8.13 换色覆盖（纯函数）
window._continentNormHue = _continentNormHue;                   // v8.13 色相归一化（纯函数）
window._continentShortName = _continentShortName;   // v8.11 T32 远景短名（纯函数）
window._continentRegions = _continentRegions;
window._continentRegionLayout = _continentRegionLayout;
window._continentLayoutGrid = _continentLayoutGrid;
window._continentRegionSourceLabel = _continentRegionSourceLabel;
window._continentSecondaryDot = _continentSecondaryDot;
window._continentRegionInfoOf = () => _continentRegionInfo;  // 验收/调试用（只读当前归属解析）
// v7.1b 门控：纯函数（无 DOM），smoke 直接断言（提示词契约/判读防御/哈希增量）
window._continentGateMessages = _continentGateMessages;
window._continentGateParse = _continentGateParse;
window._continentGateHash = _continentGateHash;
window._continentGatePendingCards = _continentGatePendingCards;
// v7.2 航线：纯函数（无 DOM），smoke 直接断言（出岛框/绕行不穿岛/标签落点 finite）
window._continentRoute = _continentRoute;
window._continentBorderPoint = _continentBorderPoint;
window._continentRouteStroke = _continentRouteStroke;
// v8 顶栏搜索 / 族表编辑 / 纠正信号：纯函数（无 DOM），smoke 直接断言
window._continentSearchMatches = _continentSearchMatches;
window._continentFamilyParseTerms = _continentFamilyParseTerms;
window._continentFamilyNormalizeList = _continentFamilyNormalizeList;
window._continentFamilySourceLabel = _continentFamilySourceLabel;
window._continentClipText = _continentClipText;

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
