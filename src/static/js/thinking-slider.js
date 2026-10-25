// ====== 思考强度滑块（2026-10-25） ======
// Codex 式分段滑块，替代槽位思考下拉：胶囊轨道＋accent 已过段＋拇指＋档位点＋短标签行
// （effort 族 关/默认/浅/深/最深，布尔族 关/默认/开；档位序与文案由 models.js 的
// _thinkingSliderEntries 供给，源头仍是 _thinkingOptionsFor）。按下即预览跟手
// （ts-dragging 关 transition），松手吸附最近档并提交；点标签＝点轨道跳最近档；
// 键盘 ←→/Home/End（role=slider）。吸附到最大档触发彩蛋：拇指光晕脉冲＋扩散光环＋
// 六颗上浮粒子（.ts-celebrate，950ms 自摘可重复触发）；停在最大档期间拇指呼吸辉光
// （.ts-at-max）。全部动效在 styles-panels.css 的 ts-* keyframes，本文件零样式。
// 冒烟沙箱兼容：document/window 是宽松代理（Symbol.toPrimitive→0，任意属性可调），
// 所有 DOM 调用在该环境下被吸收、几何值一律先 Number 收敛，构造与 API 调用均不抛错。
function createThinkingSlider(mountEl, opts) {
  opts = opts || {};
  let options = (opts.options || []).slice(); // [{value, short, title}]
  let value = typeof opts.value === 'string' ? opts.value : '';
  let onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  let disabled = !!opts.disabled;
  let root = null, fill = null, thumb = null, ticksLayer = null, labelsRow = null;
  let dots = [], labels = [];
  let celebrateTimer = null;

  function _pct(i) { const n = options.length; return n > 1 ? (i / (n - 1)) * 100 : 50; }

  function _indexOf(v) {
    let i = options.findIndex(o => o.value === v);
    if (i === -1) i = options.findIndex(o => !o.value); // 现值不在档位组里 → 回「跟随默认」（''）
    return i === -1 ? 0 : i;
  }

  function build() {
    if (!mountEl) return;
    root = document.createElement('div');
    root.className = 'thinking-slider';
    root.setAttribute('role', 'slider');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', '思考强度');
    const track = document.createElement('div');
    track.className = 'thinking-slider-track';
    fill = document.createElement('div');
    fill.className = 'thinking-slider-fill';
    ticksLayer = document.createElement('div');
    ticksLayer.className = 'thinking-slider-ticks';
    thumb = document.createElement('div');
    thumb.className = 'thinking-slider-thumb';
    const ring = document.createElement('div');
    ring.className = 'thinking-slider-ring';
    thumb.appendChild(ring);
    track.appendChild(fill);
    track.appendChild(ticksLayer);
    // 彩蛋粒子常驻 6 颗：默认透明，.ts-celebrate 下错峰上浮；起点＝轨道最右端（最大档拇指位）
    for (let i = 0; i < 6; i++) {
      const s = document.createElement('span');
      s.className = 'thinking-slider-spark';
      s.style.setProperty('--ts-delay', (i * 60) + 'ms');
      s.style.setProperty('--ts-drift', (((i % 2) ? 1 : -1) * (4 + (i % 3) * 6)) + 'px');
      track.appendChild(s);
    }
    track.appendChild(thumb);
    labelsRow = document.createElement('div');
    labelsRow.className = 'thinking-slider-labels';
    root.appendChild(track);
    root.appendChild(labelsRow);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('keydown', onKeyDown);
    mountEl.appendChild(root);
  }

  // 档位点＋短标签行（随档位组重建；点击跳档由 root 的 pointerdown 最近档映射统一处理）
  function _renderTicks() {
    if (!ticksLayer || !labelsRow) return;
    ticksLayer.innerHTML = '';
    labelsRow.innerHTML = '';
    dots = [];
    labels = [];
    options.forEach((opt, i) => {
      const d = document.createElement('span');
      d.className = 'thinking-slider-dot';
      d.style.left = _pct(i) + '%';
      ticksLayer.appendChild(d);
      dots.push(d);
      const l = document.createElement('span');
      l.className = 'thinking-slider-label';
      l.style.left = _pct(i) + '%';
      l.textContent = opt.short || opt.value || '默认';
      if (opt.title) l.setAttribute('title', opt.title);
      labelsRow.appendChild(l);
      labels.push(l);
    });
  }

  // 点/标签高亮＋ARIA＋最大档呼吸标记（i＝当前档下标）
  function _paintState(i) {
    if (!root) return;
    dots.forEach((d, j) => d.classList.toggle('on', j <= i));
    labels.forEach((l, j) => l.classList.toggle('on', j === i));
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', String(Math.max(0, options.length - 1)));
    root.setAttribute('aria-valuenow', String(i));
    root.setAttribute('aria-valuetext', (options[i] && (options[i].short || options[i].value)) || '');
    root.classList.toggle('ts-at-max', !disabled && options.length > 1 && i === options.length - 1);
  }

  function _paintPos(p) {
    if (!fill || !thumb) return;
    const pct = (isFinite(p) ? p : 0) + '%';
    fill.style.width = pct;
    thumb.style.left = pct;
  }

  function paint() {
    const i = _indexOf(value);
    _paintState(i);
    _paintPos(_pct(i));
    if (root && root.classList) root.classList.remove('ts-dragging');
  }

  function _nearestFromX(clientX) {
    const n = options.length;
    if (n < 2) return 0;
    const r = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    const w = Number(r && r.width) || 0;
    const left = Number(r && r.left) || 0;
    const t = w > 0 ? Math.min(1, Math.max(0, ((Number(clientX) || 0) - left) / w)) : 0;
    return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
  }

  function _commitIndex(i) {
    i = Math.min(options.length - 1, Math.max(0, i));
    const v = (options[i] || {}).value;
    const changed = v !== value;
    value = typeof v === 'string' ? v : '';
    paint();
    if (changed && onChange) onChange(value);
    if (changed && options.length > 1 && i === options.length - 1) celebrate();
  }

  function onPointerDown(e) {
    if (disabled || !root) return;
    if (e && e.preventDefault) e.preventDefault();
    // 按下即预览最近档（跟手从第一帧开始），提交留到松手——预览不触发 onChange
    const i0 = _nearestFromX(e && e.clientX);
    _paintPos(_pct(i0));
    _paintState(i0);
    const move = (ev) => {
      if (!root) return;
      if (root.classList) root.classList.add('ts-dragging');
      const i = _nearestFromX(ev && ev.clientX);
      _paintPos(_pct(i));
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

  function celebrate() {
    if (!root || !root.classList) return;
    root.classList.remove('ts-celebrate');
    try { void root.offsetHeight; } catch (err) {} // 强制 reflow：同档连续触发也能重放动画
    root.classList.add('ts-celebrate');
    if (celebrateTimer) clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(() => {
      celebrateTimer = null;
      if (root && root.classList) root.classList.remove('ts-celebrate');
    }, 950);
  }

  build();

  return {
    // 换供应商族时重建档位组；现值不在新组里则回「跟随默认」（不触发 onChange）
    setOptions(list) {
      options = (list || []).slice();
      if (!options.some(o => o.value === value)) value = '';
      _renderTicks();
      paint();
    },
    // 回显/换族路径专用：不触发 onChange（用户手势统一走 _commitIndex）；
    // 同样守「值∈档位组」不变量——无效档回落「跟随默认」，与绘制口径一致
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
