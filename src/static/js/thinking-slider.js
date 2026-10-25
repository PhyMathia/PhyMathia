// ====== 思考强度滑块（2026-10-25 重做，规格照搬 ZCode composer-thought-slider——
// 从本机 ZCode 应用包 app.asar 提取的轨道/填充/档点/拇指几何与动效） ======
// 结构：32px 命中区 ＞ 22px 可见轨道（前景色 10% 底）＞ 填充层（常态纯绿，停在最大
// 档淡入 绿→accent 渐变＋白色气泡横漂）＞ 均分档点（左右留拇指半径、justify-between）
// ＞ 28px 白拇指（left = (100%−28px)×t，填充宽 = 14px + (100%−28px)×t，即填到拇指圆心）。
// 档值短文字注入前置标题行（.model-thinking-caption 里追加 .ts-value，随拖动实时刷新；
// 找不到标题行就在组件内自建一行）。按下即预览跟手（ts-dragging 关过渡），松手吸附
// 最近档并提交；键盘 ←→/Home/End（role=slider）。全部动效在 styles-panels.css 的
// ts-* keyframes，本文件零样式。
// 冒烟沙箱兼容：document/window 是宽松代理（Symbol.toPrimitive→0，任意属性可调），
// 所有 DOM 调用在该环境下被吸收、几何值一律先 Number 收敛，构造与 API 调用均不抛错。
function createThinkingSlider(mountEl, opts) {
  opts = opts || {};
  const THUMB = 28, RADIUS = 14; // 拇指直径/半径（与 CSS 保持一致，几何都从这算）
  let options = (opts.options || []).slice(); // [{value, short, title}]，强度升序
  let value = typeof opts.value === 'string' ? opts.value : '';
  let onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  let disabled = !!opts.disabled;
  let root = null, fill = null, thumb = null, ticksLayer = null, valueEl = null;
  let dots = [];

  // 档位 i → 行程比例 t ∈ [0,1]（拇指圆心从左端到右端）
  function _t(i) { const n = options.length; return n > 1 ? i / (n - 1) : 0; }

  function _indexOf(v) {
    let i = options.findIndex(o => o.value === v);
    if (i === -1) i = options.findIndex(o => !o.value); // 现值不在档位组里 → 回首档兜底
    return i === -1 ? 0 : i;
  }

  // 档值文字挂点：优先注入前置标题行（index.html 每个槽位都有 model-thinking-caption）
  function _attachValueEl() {
    try {
      const cap = mountEl && mountEl.previousElementSibling;
      if (cap && cap.classList && cap.classList.contains && cap.classList.contains('model-thinking-caption')) {
        valueEl = document.createElement('span');
        valueEl.className = 'ts-value';
        cap.appendChild(valueEl);
        return;
      }
    } catch (e) {}
    valueEl = document.createElement('span'); // 兜底：组件内自建
    valueEl.className = 'thinking-slider-value';
  }

  function build() {
    if (!mountEl) return;
    root = document.createElement('div');
    root.className = 'thinking-slider';
    root.setAttribute('role', 'slider');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', '思考强度');
    _attachValueEl();
    const track = document.createElement('div');
    track.className = 'thinking-slider-track';
    fill = document.createElement('div');
    fill.className = 'thinking-slider-fill';
    // 气泡常驻 5 颗（最高档才动起来）：外层横条在填充层内右→左平移，内层白点随行；
    // 高度/大小/时长/错峰各不同，起点都在填充层右缘（overflow hidden 裁掉）
    const BUBBLES = [
      { top: 24, size: 5, dur: 3.2, delay: 0 },
      { top: 62, size: 4, dur: 4.1, delay: 0.9 },
      { top: 42, size: 6, dur: 2.7, delay: 1.7 },
      { top: 76, size: 4, dur: 3.7, delay: 0.4 },
      { top: 12, size: 4, dur: 4.6, delay: 2.3 },
    ];
    for (const b of BUBBLES) {
      const strip = document.createElement('span');
      strip.className = 'thinking-slider-bubble';
      strip.style.top = b.top + '%';
      strip.style.setProperty('--tsb-dur', b.dur + 's');
      strip.style.setProperty('--tsb-delay', b.delay + 's');
      strip.style.setProperty('--tsb-size', b.size + 'px');
      const dot = document.createElement('span');
      strip.appendChild(dot);
      fill.appendChild(strip);
    }
    ticksLayer = document.createElement('div');
    ticksLayer.className = 'thinking-slider-ticks';
    thumb = document.createElement('div');
    thumb.className = 'thinking-slider-thumb';
    track.appendChild(fill);
    track.appendChild(ticksLayer);
    track.appendChild(thumb);
    root.appendChild(track);
    if (valueEl && valueEl.className === 'thinking-slider-value') root.appendChild(valueEl);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('keydown', onKeyDown);
    mountEl.appendChild(root);
  }

  // 档位点（随档位组重建；点击跳档由 root 的 pointerdown 最近档映射统一处理）
  function _renderTicks() {
    if (!ticksLayer) return;
    ticksLayer.innerHTML = '';
    dots = [];
    options.forEach((opt, i) => {
      const d = document.createElement('span');
      d.className = 'thinking-slider-dot';
      if (opt.title) d.setAttribute('title', opt.title);
      ticksLayer.appendChild(d);
      dots.push(d);
    });
  }

  // 档点高亮＋ARIA＋最大档标记（渐变＋气泡都挂在 ts-at-max 上，CSS 驱动）
  function _paintState(i) {
    if (!root) return;
    dots.forEach((d, j) => d.classList.toggle('on', j <= i));
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', String(Math.max(0, options.length - 1)));
    root.setAttribute('aria-valuenow', String(i));
    const cur = options[i] || {};
    root.setAttribute('aria-valuetext', cur.short || cur.value || '');
    root.classList.toggle('ts-at-max', !disabled && options.length > 1 && i === options.length - 1);
    if (valueEl) valueEl.textContent = cur.short || cur.value || '';
  }

  // t ∈ [0,1] → 填充宽与拇指位（填充伸到拇指圆心，t=0 时为 0 宽＝空轨道）
  function _paintPos(t) {
    if (!fill || !thumb) return;
    const p = isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
    fill.style.width = p <= 0 ? '0px' : 'calc(' + RADIUS + 'px + (100% - ' + THUMB + 'px) * ' + p + ')';
    thumb.style.left = 'calc((100% - ' + THUMB + 'px) * ' + p + ')';
  }

  function paint() {
    const i = _indexOf(value);
    _paintState(i);
    _paintPos(_t(i));
    if (root && root.classList) root.classList.remove('ts-dragging');
  }

  // 点击/拖动位置 → 最近档下标（几何与拇指行程一致：左右各让出拇指半径）
  function _nearestFromX(clientX) {
    const n = options.length;
    if (n < 2) return 0;
    const r = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    const w = Number(r && r.width) || 0;
    const left = Number(r && r.left) || 0;
    const denom = w - THUMB;
    if (denom <= 0) return 0;
    const t = Math.min(1, Math.max(0, ((Number(clientX) || 0) - left - RADIUS) / denom));
    return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
  }

  function _commitIndex(i) {
    i = Math.min(options.length - 1, Math.max(0, i));
    const v = (options[i] || {}).value;
    const changed = v !== value;
    value = typeof v === 'string' ? v : '';
    paint();
    if (changed && onChange) onChange(value);
  }

  function onPointerDown(e) {
    if (disabled || !root) return;
    if (e && e.preventDefault) e.preventDefault();
    // 按下即预览最近档（跟手从第一帧开始），提交留到松手——预览不触发 onChange
    const i0 = _nearestFromX(e && e.clientX);
    _paintPos(_t(i0));
    _paintState(i0);
    const move = (ev) => {
      if (!root) return;
      if (root.classList) root.classList.add('ts-dragging');
      const i = _nearestFromX(ev && ev.clientX);
      _paintPos(_t(i));
      _paintState(i);
    };
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (root && root.classList) root.classList.remove('ts-dragging');
      _commitIndex(_nearestFromX(ev && ev.clientX));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function onKeyDown(e) {
    if (disabled || !root || !e || !e.key) return;
    let i = _indexOf(value);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') i += 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') i -= 1;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = options.length - 1;
    else return;
    if (e.preventDefault) e.preventDefault();
    _commitIndex(i);
  }

  build();

  return {
    // 换供应商族/代次时重建档位组；现值不在新组里则回 ''（刷新方会就近回退显示）
    setOptions(list) {
      options = (list || []).slice();
      if (!options.some(o => o.value === value)) value = '';
      _renderTicks();
      paint();
    },
    // 回显/换族路径专用：不触发 onChange（用户手势统一走 _commitIndex）
    setValue(v) {
      const nv = typeof v === 'string' ? v : '';
      value = options.some(o => o.value === nv) ? nv : '';
      paint();
    },
    getValue() { return value; },
    setDisabled(b) {
      disabled = !!b;
      if (root && root.classList) root.classList.toggle('ts-disabled', disabled);
      if (root && root.setAttribute) root.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      paint();
    },
  };
}
window.createThinkingSlider = createThinkingSlider;
