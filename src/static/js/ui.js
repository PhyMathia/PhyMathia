// ====== 难度等级管理 ======
function _setPanelTriggerState(panelId, expanded) {
  document.querySelectorAll('[aria-controls="' + panelId + '"]').forEach(btn => {
    if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-expanded', String(expanded));
  });
}

let currentLevel = localStorage.getItem(STORAGE_KEY_LEVEL) || 'university';

function updateLevelUI() {
  document.getElementById('levelBtn').innerHTML = LEVEL_ICON_SVG[currentLevel] + ' ' + LEVEL_LABELS[currentLevel];
  document.querySelectorAll('.level-option').forEach(el => {
    el.classList.toggle('active', el.dataset.level === currentLevel);
  });
}
function setLevel(level) {
  currentLevel = level;
  localStorage.setItem(STORAGE_KEY_LEVEL, level);
  updateLevelUI();
  // 隐式画像：手选难度是自我认知信号（服务端只锚定档位，不进能力向量）
  if (typeof window.reportProfileEvent === 'function') window.reportProfileEvent('difficulty', String(level || ''));
  toggleLevelPanel();
}
function toggleLevelPanel(e) {
  e?.stopPropagation();
  const panel = document.getElementById('levelPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  const trigger = e?.currentTarget || document.getElementById('levelBtn');
  _setPanelTriggerState('levelPanel', willShow);
  if (willShow) {
    document.getElementById('modelPanel').classList.remove('show');
    document.getElementById('dataPanel').classList.remove('show');
    const themePanelEl = document.getElementById('themePanel');
    if (themePanelEl) themePanelEl.classList.remove('show');
    _setPanelTriggerState('themePanel', false);
    if (typeof _closeHeaderMenus === 'function') _closeHeaderMenus();
    const modelBtn = document.getElementById('modelBtn');
    if (modelBtn && typeof modelBtn.setAttribute === 'function') modelBtn.setAttribute('aria-expanded', 'false');
    const dataBtn = document.querySelector('.data-btn');
    if (dataBtn && typeof dataBtn.setAttribute === 'function') dataBtn.setAttribute('aria-expanded', 'false');
    void panel.offsetHeight;
    _positionPanel('levelPanel', trigger);
  }
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('levelPanel');
  const btn = document.getElementById('levelBtn');
  if (panel && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.remove('show');
    _setPanelTriggerState('levelPanel', false);
  }
});
updateLevelUI();

// ====== 模型设置管理（由 models.js 模块接管）=====

function _positionPanel(panelId, triggerEl) {
  const panel = document.getElementById(panelId);
  if (!panel || !triggerEl) return;
  const rect = triggerEl.getBoundingClientRect();
  const panelW = panel.offsetWidth;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  // 水平：优先按钮左对齐，如果超出右边则右对齐
  let left = rect.left;
  if (left + panelW > viewW - 8) {
    left = viewW - panelW - 8;
  }
  if (left < 8) left = 8;
  // 垂直：面板顶部紧贴所在工具栏（顶栏 / 二级工具栏）的底部，避免遮挡工具栏
  const toolbar = triggerEl.closest('.chat-header, .header-secondary-bar');
  const top = Math.max(8, (toolbar ? toolbar.getBoundingClientRect().bottom : rect.bottom) + 6);
  // 高度不足时限制最大高度并内部滚动，避免面板翻到工具栏上方遮挡
  const maxH = Math.max(120, viewH - top - 8);
  panel.style.left = left + 'px';
  panel.style.right = 'auto';
  panel.style.top = top + 'px';
  panel.style.maxHeight = maxH + 'px';
  panel.style.overflowY = 'auto';
  // 知识菜单例外（2026-10-03）：它带「知识检测」悬停子菜单，子面板 absolute 在面板左外侧，
  // overflow:auto 会把面板框外的子菜单整个裁掉——该菜单只有三行，放弃内部滚动换子菜单完整显示。
  if (panelId === 'knowledgeMenu') panel.style.overflowY = 'visible';
}

function toggleModelPanel(e) {
  e?.stopPropagation();
  const panel = document.getElementById('modelPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  const trigger = e && e.currentTarget ? e.currentTarget : document.getElementById('modelBtn');
  _setPanelTriggerState('modelPanel', willShow);
  // Close other panels
  document.getElementById('levelPanel').classList.remove('show');
  document.getElementById('dataPanel').classList.remove('show');
  _setPanelTriggerState('levelPanel', false);
  _setPanelTriggerState('dataPanel', false);
  const themePanelEl = document.getElementById('themePanel');
  if (themePanelEl) themePanelEl.classList.remove('show');
  _setPanelTriggerState('themePanel', false);
  if (typeof _closeHeaderMenus === 'function') _closeHeaderMenus();
  if (willShow) {
    renderModelList();
    renderModelSelects();
    void panel.offsetHeight;
    _positionPanel('modelPanel', trigger);
  }
}

function toggleDataPanel(e) {
  const panel = document.getElementById('dataPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  const trigger = e && e.currentTarget ? e.currentTarget : document.querySelector('[aria-controls="dataPanel"]');
  _setPanelTriggerState('dataPanel', willShow);
  if (willShow && typeof window._positionPanelBelowBtn === 'function') window._positionPanelBelowBtn(panel, trigger);
  // Close other panels
  document.getElementById('levelPanel').classList.remove('show');
  document.getElementById('modelPanel').classList.remove('show');
  _setPanelTriggerState('levelPanel', false);
  _setPanelTriggerState('modelPanel', false);
  const themePanelEl = document.getElementById('themePanel');
  if (themePanelEl) themePanelEl.classList.remove('show');
  _setPanelTriggerState('themePanel', false);
  if (typeof _closeHeaderMenus === 'function') _closeHeaderMenus();
  // Show data stats
  updateDataStats();
  if (willShow) {
    // Force reflow so offsetWidth/offsetHeight are available
    void panel.offsetHeight;
    _positionPanel('dataPanel', trigger);
  }
}

// Close model/data panel on outside click
document.addEventListener('click', (e) => {
  // 事件处理器里重建过 DOM 时，e.target 可能已脱离文档（detached）——此时
  // contains 恒为 false，会把面板内点击误判为“点外部”而关闭；跳过这类事件
  if (e.target && !e.target.isConnected) return;
  const panels = [
    { el: document.getElementById('modelPanel'), btns: document.querySelectorAll('[onclick*="toggleModelPanel"]') },
    { el: document.getElementById('dataPanel'), btns: document.querySelectorAll('[onclick*="toggleDataPanel"]') }
  ];
  panels.forEach(({ el, btns }) => {
    if (!el) return;
    const clickedBtn = Array.from(btns).some(btn => btn.contains(e.target));
    if (!el.contains(e.target) && !clickedBtn) {
      el.classList.remove('show');
    }
  });
});

// models.js is loaded before the model panel markup in index.html.
// The initial render is performed from the window load handler below.


/* ====================================================
 * 漂浮数学物理符号（海面漂浮效果 + 鼠标交互）
 * ==================================================== */
(function initFloatingSymbols() {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // 符号池：匹配背景图上的公式和符号
  const symbolPool = [
    'e^{iπ}+1=0', '∫', '∂', '∇', 'Σ', 'Δ', 'λ', 'ω', 'φ', 'π',
    'ε₀', 'F=ma', 'E=mc²', '∇·E=ρ/ε₀', '∂²u/∂t²=c²∇²u',
    '∑1/n²=π²/6', 'd²x/dt²=-kx/m', '∮', 'ℏ', 'α', 'β', 'γ',
    'θ', 'μ', 'σ', 'τ', 'ψ', 'Ω'
  ];

  const SYMBOL_COUNT = isMobile ? 18 : 33;
  const REPEL_RADIUS = 120;
  const REPEL_STRENGTH = 0.6;

  let mouseX = -1000, mouseY = -1000;
  let smoothMouseX = -1000, smoothMouseY = -1000;

  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });
  document.addEventListener('mouseleave', () => {
    mouseX = -1000;
    mouseY = -1000;
  });
  // 移动端触摸交互
  if (isMobile) {
    document.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        mouseX = e.touches[0].clientX;
        mouseY = e.touches[0].clientY;
      }
    }, { passive: true });
    document.addEventListener('touchend', () => {
      mouseX = -1000;
      mouseY = -1000;
    }, { passive: true });
  }

  const container = document.createElement('div');
  container.id = 'floating-symbols';
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;';
  document.body.appendChild(container);

  class FloatingSymbol {
    constructor(index) {
      this.el = document.createElement('span');
      this.text = symbolPool[index % symbolPool.length];
      this.el.textContent = this.text;

      const isFormula = this.text.length > 3;
      this.size = isFormula ? 14 + Math.random() * 8 : 18 + Math.random() * 16;
      // 静态外观一次写定（2026-10-01 第四轮·撤回）：原先 applyTheme 每次都整段重写
      // cssText，切主题时 33 个符号各重解析 8 条声明。拆开后 applyTheme 只写主题相关的
      // color/text-shadow 两项，同步换色零滞后再无逐段重解析的开销。
      this.el.style.cssText = `
        position:absolute; left:0; top:0;
        font-family: 'Cambria Math','Latin Modern Math','STIX Two Math','Times New Roman',serif;
        font-size:${this.size}px;
        user-select:none; will-change:transform,opacity; pointer-events:none;
      `;

      this.x = Math.random() * window.innerWidth;
      this.y = Math.random() * window.innerHeight;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.vy = (Math.random() - 0.5) * 0.15;

      this.bobPhase = Math.random() * Math.PI * 2;
      this.bobSpeed = 0.008 + Math.random() * 0.012;
      this.bobAmp = 1.5 + Math.random() * 3;

      this.rotation = (Math.random() - 0.5) * 20;
      this.rotSpeed = (Math.random() - 0.5) * 0.15;

      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      this.baseOpacity = dark
        ? (isFormula ? 0.12 + Math.random() * 0.12 : 0.15 + Math.random() * 0.2)
        : (isFormula ? 0.05 + Math.random() * 0.06 : 0.06 + Math.random() * 0.10);
      this.repelVx = 0;
      this.repelVy = 0;

      this.applyTheme();
      container.appendChild(this.el);
    }

    applyTheme() {
      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      const isFormula = this.text.length > 3;
      // 符号配色读壁纸套配置（config.js WALLPAPER_SETS[].symbols，2026-10-02）：颜色/光晕/
      // 透明度系数按「当前模式的壁纸套」深浅两档取；配置缺字段时回落原有硬编码（星夜值）。
      // 注意别引用 currentTheme 变量——本 IIFE 在脚本前段执行，那时它还没赋值，读 data-theme
      // 属性才是启动期也成立的口径（同函数上方 dark 的取法）。
      let sym = null;
      try {
        if (typeof WALLPAPER_SETS !== 'undefined' && typeof getWallpaperId === 'function') {
          const theme0 = document.documentElement.getAttribute('data-theme');
          const id = getWallpaperId(theme0 === 'light' ? 'light' : 'dark');
          const set = WALLPAPER_SETS.find(s => s.id === id);
          if (set && set.symbols) sym = dark ? set.symbols.dark : set.symbols.light;
        }
      } catch (e) {}
      const opScale = sym && typeof sym.opacity === 'number' ? sym.opacity : 1;
      this.baseOpacity = (dark
        ? (isFormula ? 0.12 + Math.random() * 0.12 : 0.15 + Math.random() * 0.2)
        : (isFormula ? 0.08 + Math.random() * 0.08 : 0.10 + Math.random() * 0.12)) * opScale;
      this.el.style.color = (sym && sym.color) || (dark ? 'var(--sym-night-dark-ink)' : 'var(--sym-night-light-ink)');
      const glow = (sym && sym.glow) || (dark ? 'var(--sym-night-dark-glow)' : 'var(--sym-night-light-glow)');
      const glowSize = sym && typeof sym.glowSize === 'number' ? sym.glowSize : (dark ? 8 : 6);
      this.el.style.textShadow = '0 0 ' + glowSize + 'px ' + glow;
    }

    update() {
      this.bobPhase += this.bobSpeed;
      const bobY = Math.sin(this.bobPhase) * this.bobAmp;
      const bobX = Math.cos(this.bobPhase * 0.7) * this.bobAmp * 0.5;

      this.x += this.vx;
      this.y += this.vy;
      this.rotation += this.rotSpeed;

      const dx = this.x - smoothMouseX;
      const dy = this.y - smoothMouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < REPEL_RADIUS && dist > 0) {
        const force = (1 - dist / REPEL_RADIUS) * REPEL_STRENGTH;
        this.repelVx += (dx / dist) * force;
        this.repelVy += (dy / dist) * force;
      }
      this.repelVx *= 0.94;
      this.repelVy *= 0.94;

      const margin = 60;
      if (this.x < -margin) this.x = window.innerWidth + margin;
      if (this.x > window.innerWidth + margin) this.x = -margin;
      if (this.y < -margin) this.y = window.innerHeight + margin;
      if (this.y > window.innerHeight + margin) this.y = -margin;

      const finalX = this.x + bobX + this.repelVx;
      const finalY = this.y + bobY + this.repelVy;
      this.el.style.transform = `translate(${finalX}px,${finalY}px) rotate(${this.rotation}deg)`;

      const highlight = dist < REPEL_RADIUS ? 1 + (1 - dist / REPEL_RADIUS) * 0.4 : 1;
      this.el.style.opacity = this.baseOpacity * highlight;
    }
  }

  const symbols = [];
  // 符号密度随壁纸套（2026-10-02 用户拍板）：count 为桌面数量（星夜 33 / 素纸 42 / 山影 28），
  // 移动端按 18/33 比例折算、下限 10。换套/切模式（深浅分键、两模式所选可不同）由
  // __syncFloatingSymbols 重建——≤42 个 span 的廉价操作。读 data-theme 属性而非
  // currentTheme 变量：本 IIFE 在脚本前段执行，那时它还没赋值。
  function _desiredSymbolCount() {
    let count = 33;
    try {
      if (typeof WALLPAPER_SETS !== 'undefined' && typeof getWallpaperId === 'function') {
        const theme0 = document.documentElement.getAttribute('data-theme');
        const id = getWallpaperId(theme0 === 'light' ? 'light' : 'dark');
        const set = WALLPAPER_SETS.find(s => s.id === id);
        if (set && set.symbols && set.symbols.count) count = set.symbols.count;
      }
    } catch (e) {}
    return isMobile ? Math.max(10, Math.round(count * 18 / 33)) : count;
  }
  function _rebuildSymbols(count) {
    for (const s of symbols) s.el.remove();
    symbols.length = 0;
    for (let i = 0; i < count; i++) symbols.push(new FloatingSymbol(i));
  }
  window.__syncFloatingSymbols = function () {
    const want = _desiredSymbolCount();
    if (want !== symbols.length) _rebuildSymbols(want);
    for (const s of symbols) s.applyTheme();
  };
  for (let i = 0; i < _desiredSymbolCount(); i++) symbols.push(new FloatingSymbol(i));

  // 粒子是纯装饰，但每帧 33 次 transform/opacity 写会压缩交互帧的 16ms 预算。
  // 重活期间（AI 流式生成、画布拖拽）整段暂停，恢复后从当前状态继续——
  // 各暂停方通过计数器叠加，全部恢复才重新启动循环。
  let _symbolAnimRaf = 0;
  let _symbolPauseCount = 0;
  function _symbolLoop() {
    _symbolAnimRaf = 0;
    smoothMouseX += (mouseX - smoothMouseX) * 0.1;
    smoothMouseY += (mouseY - smoothMouseY) * 0.1;
    for (const sym of symbols) sym.update();
    if (_symbolPauseCount === 0) _symbolAnimRaf = requestAnimationFrame(_symbolLoop);
  }
  // 极光漂移与漂浮符号同一套让路口径：计数>0（AI 流式/画布拖拽）或标签页隐藏时，
  // 给 <html> 挂 aurora-paused，由 styles.css 暂停各玻璃载体的 background-position 漂移
  // （瞬态浮层豁免清单见 styles.css aurora-paused 注释）
  function _updateAuroraPause() {
    document.documentElement.classList.toggle('aurora-paused', _symbolPauseCount > 0 || document.hidden);
  }
  window.setFloatingSymbolsPaused = function (paused) {
    _symbolPauseCount = Math.max(0, _symbolPauseCount + (paused ? 1 : -1));
    _updateAuroraPause();
    if (_symbolPauseCount > 0) {
      if (_symbolAnimRaf) { cancelAnimationFrame(_symbolAnimRaf); _symbolAnimRaf = 0; }
    } else if (!_symbolAnimRaf) {
      _symbolAnimRaf = requestAnimationFrame(_symbolLoop);
    }
  };
  _symbolAnimRaf = requestAnimationFrame(_symbolLoop);
  document.addEventListener('visibilitychange', _updateAuroraPause);

  // 慢机降级探测（2026-10-01）：LoAF 实测漂移与符号画布单独跑都够帧、叠加必爆 200-380ms
  // 长帧（切主题时全部玻璃整帧重绘再叠一层，感知就是「切一次卡好几秒」）。两阶段探测：
  // 先测当前帧间隔中位数，再临时挂 aurora-still 冻结漂移复测——只有冻结确实换来明显改善
  // （>1.4 倍且省 8ms 以上）才保留降级。与屏幕刷新率无关，快机器/低刷面板自动不降。
  let _probeTries = 0;
  function _sampleFrameGap(cb) {
    const gaps = [];
    let last = 0, n = 0;
    const tick = (t) => {
      if (last) {
        const g = t - last;
        if (g > 2 && g < 200) gaps.push(g); // 标签页隐藏/偶发长任务的不采样
      }
      last = t;
      if (++n < 45) requestAnimationFrame(tick);
      else cb(gaps);
    };
    requestAnimationFrame(tick);
  }
  function _medianOf(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] || 999;
  }
  function _probeAuroraBudget() {
    const root = document.documentElement;
    _sampleFrameGap((withAnim) => {
      if (withAnim.length < 30) {           // 有效样本不足（页隐藏/被打断）稍后重测
        if (++_probeTries < 3) setTimeout(_probeAuroraBudget, 2000);
        return;
      }
      const m1 = _medianOf(withAnim);
      if (m1 <= 18) return;                 // 稳 60fps，不用降级
      root.classList.add('aurora-still');
      setTimeout(() => {
        _sampleFrameGap((withoutAnim) => {
          if (withoutAnim.length < 30) { root.classList.remove('aurora-still'); return; }
          const m2 = _medianOf(withoutAnim);
          if (!(m1 > m2 * 1.4 && m1 - m2 > 8)) root.classList.remove('aurora-still');
        });
      }, 400);
    });
  }
  window.addEventListener('load', () => setTimeout(_probeAuroraBudget, 1200));

  const origToggle = window.toggleTheme;
  window.toggleTheme = function() {
    if (origToggle) origToggle();
    // 同步换色（第四轮曾延后 300ms「挪出翻转帧」，当天被用户实报符号慢一拍即撤回——
    // 本项目第三次「性能延后→可见滞后→回收」）。同步零滞后，且 applyTheme 已收窄成
    // 只写 color/text-shadow 两个属性，每次切换的样式工作量比延后前还小。
    for (const sym of symbols) sym.applyTheme();
  };
})();

// ====== 简易 Toast ======
function showToast(msg, duration = 2500) {
  let toast = document.getElementById('phymathia_toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'phymathia_toast';
    // 第 5 轮磨砂化：全局 toast 统一极光磨砂（--compact 胶囊档）——
    // 底色/阴影归玻璃类，内联样式里不能再写 background（会整块盖掉极光层）
    toast.className = 'aurora-glass aurora-glass--compact';
    toast.style.cssText = 'position:fixed;bottom:120px;left:50%;transform:translateX(-50%) translateY(10px);color:var(--text-primary);border:1px solid var(--border-color);border-radius:10px;padding:10px 20px;font-size:13px;z-index:9999;opacity:0;transition:opacity 0.3s,transform 0.3s;pointer-events:none;white-space:nowrap;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(10px)';
  }, duration);
}

function showCompletionCard(title, subtitle, duration = 4000) {
  let card = document.getElementById('phymathia_completion_card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'phymathia_completion_card';
    // 第 5 轮磨砂化：完成通知卡统一极光磨砂（基础档小浮层）；styles.css 里本载体的
    // background/box-shadow 已拔掉
    card.className = 'completion-card aurora-glass';
    card.innerHTML =
      '<div class="completion-card-icon">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
      '</div>' +
      '<div class="completion-card-content">' +
      '<div class="completion-card-title"></div>' +
      '<div class="completion-card-subtitle"></div>' +
      '</div>' +
      '<button class="completion-card-close" title="关闭" aria-label="关闭">×</button>';
    card.querySelector('.completion-card-close').addEventListener('click', function () {
      hideCompletionCard(card);
    });
    document.body.appendChild(card);
  }
  card.querySelector('.completion-card-title').textContent = title;
  card.querySelector('.completion-card-subtitle').textContent = subtitle || '';
  requestAnimationFrame(function () {
    card.classList.add('show');
  });
  clearTimeout(card._timer);
  card._timer = setTimeout(function () {
    hideCompletionCard(card);
  }, duration);
}

function hideCompletionCard(card) {
  if (!card) card = document.getElementById('phymathia_completion_card');
  if (!card) return;
  card.classList.remove('show');
}

let _completionAudioContext = null;

function playCompletionSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!_completionAudioContext) _completionAudioContext = new AudioContextClass();
    const ctx = _completionAudioContext;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const tones = [
      { at: 0, frequency: 880, duration: 0.18 },
      { at: 0.16, frequency: 1174.66, duration: 0.22 }
    ];
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.frequency;
      gain.gain.setValueAtTime(0.0001, now + tone.at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + tone.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.at);
      osc.stop(now + tone.at + tone.duration + 0.02);
    }
  } catch (e) {
    // 浏览器限制或音频设备不可用时静默跳过提示音
  }
}

function notifyTaskCompleted(durationMs, label = '任务完成') {
  const ms = Math.max(0, Number(durationMs) || 0);
  const durationText = typeof formatDuration === 'function' ? formatDuration(ms) : Math.ceil(ms / 1000) + 's';
  const labelText = String(label || '任务完成');
  let title = labelText;
  let rest = '';
  if (labelText.indexOf('工作流完成') === 0) {
    title = '工作流完成';
    rest = labelText.slice('工作流完成'.length).replace(/^[·\s]+/, '');
  }
  const subtitle = [rest, '用时 ' + durationText].filter(Boolean).join(' · ');
  showCompletionCard(title, subtitle);
  playCompletionSound();
}

document.addEventListener('pointerdown', () => {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || _completionAudioContext) return;
    _completionAudioContext = new AudioContextClass();
    if (_completionAudioContext.state === 'suspended') _completionAudioContext.resume().catch(() => {});
  } catch (e) {
    // 音频上下文预热失败不影响任务本身
  }
}, { passive: true });
// T45：窗口缩放不再静默关浮动面板——面板开着就按触发按钮重新定位
// （_positionPanel 可重入；此前无条件 remove('show')，日常拉伸窗口四个面板全没）
function _repositionShownPanel(panelId, findTrigger) {
  const panel = document.getElementById(panelId);
  if (!panel || !panel.classList.contains('show')) return;
  const trigger = findTrigger();
  if (!trigger) return;
  if (panelId === 'dataPanel' && typeof window._positionPanelBelowBtn === 'function') {
    window._positionPanelBelowBtn(panel, trigger);
  } else {
    _positionPanel(panelId, trigger);
  }
}

// Handle resize during onboarding
window.addEventListener('resize', () => {
  if (_obStep >= 0) _renderObStep();
  const exampleOverlay = document.getElementById('exampleGuideOverlay');
  if (exampleOverlay && exampleOverlay.classList.contains('active')) _renderExampleGuideStep();
  _repositionShownPanel('modelPanel', () => document.getElementById('modelBtn'));
  _repositionShownPanel('dataPanel', () => document.querySelector('[aria-controls="dataPanel"]'));
  _repositionShownPanel('levelPanel', () => document.getElementById('levelBtn'));
  _repositionShownPanel('themePanel', () => document.getElementById('themePickBtn'));
  _repositionShownPanel('knowledgeMenu', () => document.getElementById('knowledgeBtn'));
  _repositionShownPanel('moreMenu', () => document.getElementById('moreBtn'));
});

// ESC 关闭可视化全屏
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const exampleGuide = document.getElementById('exampleGuideOverlay');
    if (exampleGuide && exampleGuide.classList.contains('active')) {
      closeExampleGuide();
      return;
    }
    // 知识总览面板：Esc 关面板；批量摘要优化运行中不关——Esc 让给 knowledge.js
    // 的批量中止 capture 监听（先于本监听触发），面板保持打开供继续控制
    const knowledgePanel = document.getElementById('knowledgePanel');
    if (knowledgePanel && knowledgePanel.classList.contains('active')) {
      if (typeof isKnowledgeSummaryOptimizeRunning !== 'function' || !isKnowledgeSummaryOptimizeRunning()) {
        closeKnowledgePanel();
      }
      return;
    }
    const overlay = document.getElementById('vizFullscreenOverlay');
    if (overlay && overlay.classList.contains('active')) {
      closeVizFullscreen();
    }
  }
});

// ====== 页面加载 ======
window.addEventListener('load', async () => {
  await fetchModels();
  // 账号指针自愈（T185）：指针悬空（账号已被删）时先回落并重载，不进应用初始化
  if (typeof _accountsRecoverIfMissing === 'function' && await _accountsRecoverIfMissing()) return;
  // 必须先初始化应用（加载 session、恢复聊天状态）
  await initApp();

  // 首次使用引导（查阅模式跳过：引导完成标记会写进对方账号的浏览器命名空间）
  setTimeout(() => { if (!phyIsReadonly()) startOnboarding(); }, 600);
});

// ====== 深色/浅色模式 ======

// Preload all background images for instant theme switch
// 预加载并保留句柄（2026-10-01 第四轮）：翻转时若句柄已 complete，updateBgImage
// 可与 data-theme 同帧直换壁纸。原先句柄创建后即弃，new Image() 的 complete 在
// 同步赋 src 的当帧必为 false（真机实测翻转后 80ms 壁纸仍旧图）。
const _bgPreloaded = new Map();
// 预载清单走 WALLPAPER_SETS（2026-10-02 壁纸库）：每套深浅×横竖全量预载，挑选器即点即换
[
  ...WALLPAPER_SETS.flatMap(s => [s.dark.land, s.dark.port, s.light.land, s.light.port]),
  '/logo.png'
].forEach(src => {
  const img = new Image();
  img.src = src;
  _bgPreloaded.set(src, img);
});

// 首次访问（localStorage 无值）跟随系统偏好，手动切换后以手动选择为准
function _getInitialTheme() {
  let t = null;
  try { t = localStorage.getItem(STORAGE_KEY_THEME); } catch (e) {}
  if (t === 'light' || t === 'dark') return t;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
}

let currentTheme = _getInitialTheme();

// 主题切换窗口（2026-10-01 渐变整体删除后保留，当天再收窄为单职责）：只负责掐掉
// 组件自有的 hover 过渡（否则翻转时各补一段迷你淡变），250ms 足够。原「窗口内摘
// 节点卡磨砂」已删：它防的是交叉淡入期间背景逐帧变、磨砂跟着逐帧重算的风暴，
// 渐变删除后背景每次切换只换一次、磨砂只重算一次，摘除已无收益，反而让 candy
// 卡片窗口内失磨砂、结束再弹回（用户实报「切换后样式晚零点几秒」）。慢机兜底
// 仍是 node-blur-lite 首切探测。
let _themeSwitchTimer = null;
let _themeSwitchAuroraTimer = null;

// 慢机磨砂降级探测（2026-10-01）：candy 皮肤节点卡 backdrop-filter: blur(16px) 在翻转
// 主题时要全量重算磨砂，软件光栅机器上实测 1.3s 的长帧风暴（LoAF 逐项排除其余元凶后，
// 仅关此项归零）。首次真实切换后统计 2.2s 内长帧总量，>600ms 判为慢光栅机，给 <html>
// 挂 node-blur-lite（styles.css：节点卡改用半透明底色直接透出背景，不再逐张实时磨砂）。
// 判定跨会话记忆（2026-10-01 第四轮）：原「只当次会话」意味着慢机每个会话的第一次切换
// 都先吃满风暴、探测才生效——用户实报「还是卡」的主因之一。判定即写 localStorage
// （STORAGE_KEY_FLIP_SLOW，存时间戳），下次启动直接预挂；30 天过期重探（机器升级自愈），
// 预挂后本会话不再探测（带着降级测必然便宜，测了也会误清）。快机误伤路径：翻转正逢
// 后台重载导致偶发超阈 → _lite 观感 30 天，代价＝磨砂变半透明底，可清该键复原。
let _flipProbeDone = false;
const _FLIP_SLOW_TTL_MS = 30 * 24 * 3600 * 1000;

(function _armFlipSlowFromStorage() {
  let t = 0;
  try { t = Number(localStorage.getItem(STORAGE_KEY_FLIP_SLOW)) || 0; } catch (e) {}
  if (!t) return;
  if (Date.now() - t < _FLIP_SLOW_TTL_MS) {
    document.documentElement.classList.add('node-blur-lite');
    _flipProbeDone = true;
  } else {
    try { localStorage.removeItem(STORAGE_KEY_FLIP_SLOW); } catch (e) {}
  }
})();

function _probeFlipCost() {
  const heavy = [];
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 100) heavy.push(e.duration);
    });
    po.observe({ type: 'long-animation-frame', buffered: false });
  } catch (e) { return; }
  setTimeout(() => {
    if (po) po.disconnect();
    if (heavy.reduce((a, b) => a + b, 0) > 600) {
      document.documentElement.classList.add('node-blur-lite');
      try { localStorage.setItem(STORAGE_KEY_FLIP_SLOW, String(Date.now())); } catch (e) {}
    }
  }, 2200);
}

function applyTheme(theme) {
  const root = document.documentElement;
  const prevTheme = root.getAttribute('data-theme');
  // 只在真实翻转时挂切换窗口：启动时 applyTheme 也走这里、prevTheme 为 null——
  // 原先无差别挂窗口，candy 皮肤开机头几百 ms 节点卡也没磨砂（与切换后弹回同源）。
  const flipped = prevTheme !== null && prevTheme !== theme;
  if (flipped) {
    root.classList.add('theme-switching');
    // 切换窗口内让路（与画布拖拽/AI 流式同一 setFloatingSymbolsPaused 计数口径）：
    // 翻转主题会让全部玻璃载体整帧重绘，漂移+符号在同一帧预算里叠加实测爆出
    // 200-380ms 长帧；暂停 500ms 盖过 250ms 切换窗口全程，aurora-paused 由计数器自动挂上。
    if (typeof window.setFloatingSymbolsPaused === 'function') {
      window.setFloatingSymbolsPaused(true);
      clearTimeout(_themeSwitchAuroraTimer);
      _themeSwitchAuroraTimer = setTimeout(() => window.setFloatingSymbolsPaused(false), 500);
    }
    // 250ms ≈ 15 帧：类与 data-theme 同任务挂上，hover 过渡在唯一一次重算里就被掐死
    if (_themeSwitchTimer) clearTimeout(_themeSwitchTimer);
    _themeSwitchTimer = setTimeout(() => root.classList.remove('theme-switching'), 250);
  }
  currentTheme = theme;
  root.setAttribute('data-theme', theme);
  if (flipped && !_flipProbeDone) {
    _flipProbeDone = true;
    _probeFlipCost();
  }
  localStorage.setItem(STORAGE_KEY_THEME, theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = theme === 'dark' ? UI_ICON_SVG.moon : UI_ICON_SVG.sun;
  updateBgImage();
  // 深浅主题联动（2026-10-02 第三轮拍板：默认共用、开关才独立）。联动态下两模式壁纸键若
  // 历史遗留不同值（旧版「各记各的」时代写的），按当前模式的所选收拢成同值——否则翻深浅
  // 会看到「主题没跟随」。首次收拢后两键恒等，此后每次翻转只剩两次读、零写入。
  if (!themeSplitEnabled()) {
    const wpD = getWallpaperId('dark');
    const wpL = getWallpaperId('light');
    if (wpD !== wpL) {
      const cur = getWallpaperId(currentTheme);
      setWallpaper(cur, 'dark');
      setWallpaper(cur, 'light');
    }
  }
  // 独立模式两模式家族可能不同：翻转后按新模式重挂双属性（联动态同值幂等）。
  applyStyleFamily(currentStyleFamily());
  // 深浅各自所选的壁纸套可以不同（phymathia_bg_dark/_light 分键）→ 模式翻转也可能换套：
  // 符号密度/配色跟着重算（2026-10-02 用户拍板：符号颜色与数量随壁纸主题走）
  if (typeof window.__syncFloatingSymbols === 'function') window.__syncFloatingSymbols();
  // 同步所有可视化 iframe 的主题（含全屏）——广播保持同步：延后 250ms 曾是第四轮的
  // 「翻转帧减负」，但 iframe 本就在消息任务里翻、叠不进主文档那一帧，收益纯属推测，
  // 与符号延后同批撤回（用户实报符号慢一拍），不让任何载体留可见滞后
  if (typeof syncVizThemes === 'function') syncVizThemes(theme);
  // 渐变删除后颜色即切即稳，Mermaid 配置直接更新（只影响未来新图表的配色）
  if (typeof configureMermaid === 'function' && typeof getMermaidConfig === 'function') {
    configureMermaid(getMermaidConfig(theme === 'dark'));
  }
}

function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// 背景图即切（2026-10-01 渐变删除）：原双层 0.6s 交叉淡入随主题切换渐变整体删除，
// 只用 bgLayer1 直接换图，预加载完成后再换、避免解码期露底。bgLayer2 元素与
// #bgLayer2{opacity:0} 留在 DOM（空层零成本）。附带修正：graph-export.js 只读
// bgLayer1 挂的图，旧交叉淡入会把当前层停在 bgLayer2，导出壁纸可能读到旧图。
let _bgInitialized = false;
let _bgCurrentUrl = null;
function _desiredBgUrl() {
  const isLandscape = window.innerWidth > window.innerHeight;
  const m = currentTheme === 'dark' ? currentWallpaperSet().dark : currentWallpaperSet().light;
  return isLandscape ? m.land : m.port;
}
// 壁纸套 id 上 DOM（.bg-overlay 按套分档的 CSS 读取依据）：与壁纸图同一同步块落地，
// 防「有图无纱/有纱无图」的错配帧。
function _markWallpaperSet() {
  document.documentElement.setAttribute('data-wallpaper', getWallpaperId(currentTheme));
}

function updateBgImage() {
  const newUrl = _desiredBgUrl();
  if (_bgCurrentUrl === newUrl) return;

  const el = document.getElementById('bgLayer1');
  if (!el) return;

  // 首次加载：图多半已在缓存外的首屏路径上，直接设置
  if (!_bgInitialized) {
    _markWallpaperSet();
    el.style.backgroundImage = `url('${newUrl}')`;
    el.style.opacity = '1';
    _bgInitialized = true;
    _bgCurrentUrl = newUrl;
    return;
  }

  // 预加载完成后再换，换完即最终态（无淡入）；连切/转屏时晚到的旧图不落地。
  // 壁纸与 data-theme 同帧落地（2026-10-01 第四轮）：启动预加载句柄已 complete 就
  // 同任务直换——否则 onload 至少晚一帧＝每次切换两次全窗光栅，中间还有一帧
  // 「新配色压旧主题壁纸」的错配（慢机上第二次全窗光栅不便宜）。句柄未就绪或
  // 冷缓存则退回异步等载，行为与旧版一致。
  const apply = function() {
    if (_desiredBgUrl() !== newUrl) return;
    _markWallpaperSet();
    el.style.backgroundImage = `url('${newUrl}')`;
    _bgCurrentUrl = newUrl;
  };
  const pre = _bgPreloaded.get(newUrl);
  if (pre && pre.complete && pre.naturalWidth > 0) { apply(); return; }
  const img = new Image();
  img.onload = apply;
  img.src = newUrl;
}

// Apply saved theme on load
applyTheme(currentTheme);
let _resizeTimer;
function updateBgImageDebounced() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(updateBgImage, 200);
}
window.addEventListener('resize', updateBgImageDebounced);
window.addEventListener('orientationchange', () => setTimeout(updateBgImage, 300));

/* ====================================================
 * 风格家族（2026-10-02 用户拍板：面板质感＋节点皮肤＋强调色焊成一个开关）
 * 一个 key 同时挂 html 根的 data-node-skin 与 data-panel-skin 两属性（家族即皮肤
 * 超集），CSS 两侧各有平行覆盖块；默认族 aurora 不挂属性＝基础规则即默认。
 * 注册表在 config.js（STYLE_FAMILIES，含主题默认搭配 THEME_DEFAULT_FAMILY）；
 * 入口在页头「主题」钮 → #themePanel（壁纸主题卡＋风格五选一，见下方挑选器段）。
 * 老用户迁移：家族键缺位时从旧 phymathia_node_skin 折算（皮肤 key ⊆ 家族 key）。
 * ==================================================== */
const GRAPH_NODE_SKINS = [
  { key: 'aurora', label: '极光磨砂', desc: '渐变半透明磨砂玻璃（默认）' },
  { key: 'blueprint', label: '蓝图制图', desc: '工程蓝图：蓝图纸面＋虚线描边＋淡网格' },
  { key: 'inkstone', label: '砚石·墨韵', desc: '青黑哑光石面＋石纹描边＋收敛投影' },
  { key: 'neon', label: '霓虹夜光', desc: '近黑卡面＋属性色霓虹描边与外发光' },
  { key: 'candy', label: '糖果磨砂', desc: '奶白磨砂玻璃＋马卡龙属性色柔光' },
];
// 面板行图标：风格家族统一用「层」字形（模板叠放语义）；以后某家族要专属图标再进注册表
const SKIN_OPTION_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>';

// 深浅独立开关（2026-10-02 第三轮用户拍板：默认两模式共用同一主题，翻深浅主题跟手；
// 勾选后才各挑各的）。读侧永远按模式取键，联动只是「写时双写」——所以对账/收拢都靠写侧。
function _familyModeKey(theme) {
  return theme === 'light' ? STORAGE_KEY_STYLE_FAMILY_LIGHT : STORAGE_KEY_STYLE_FAMILY_DARK;
}
function themeSplitEnabled() {
  let v = null;
  try { v = localStorage.getItem(STORAGE_KEY_THEME_SPLIT); } catch (e) {}
  return v === '1';
}
function currentStyleFamily() {
  let v = null;
  try { v = localStorage.getItem(themeSplitEnabled() ? _familyModeKey(currentTheme) : STORAGE_KEY_STYLE_FAMILY); } catch (e) {}
  if (!v && themeSplitEnabled()) {
    // 分模式键缺位＝开独立后该侧还没挑过 → 回落共享键（开启瞬间已落种，此处只兜异常态）
    try { v = localStorage.getItem(STORAGE_KEY_STYLE_FAMILY); } catch (e) {}
  }
  if (!v) {
    // 迁移（2026-10-02）：家族键缺位＝老用户，从旧节点皮肤键折算（同 key 直接对应家族）
    try { v = localStorage.getItem(STORAGE_KEY_NODE_SKIN); } catch (e) {}
  }
  return STYLE_FAMILIES.some(f => f.key === v) ? v : STYLE_FAMILIES[0].key;
}

function applyStyleFamily(key) {
  const fam = STYLE_FAMILIES.some(f => f.key === key) ? key : STYLE_FAMILIES[0].key;
  try {
    if (themeSplitEnabled()) {
      localStorage.setItem(_familyModeKey(currentTheme), fam);
      // 共享键镜像最近一次挑选：viewer 内联预置等只读共享键的读者继续跟随导出时刻
      localStorage.setItem(STORAGE_KEY_STYLE_FAMILY, fam);
    } else {
      localStorage.setItem(STORAGE_KEY_STYLE_FAMILY, fam);
    }
    localStorage.setItem(STORAGE_KEY_NODE_SKIN, fam); // 旧键同步写：图导出快照等旧读者兼容
  } catch (e) {}
  // 默认族 aurora 不挂属性：基础节点规则与极光玻璃本身就是默认（与 data-node-skin 同契约），
  // localStorage 里的未知旧值也安全回落默认
  if (fam === STYLE_FAMILIES[0].key) {
    document.documentElement.removeAttribute('data-node-skin');
    document.documentElement.removeAttribute('data-panel-skin');
  } else {
    document.documentElement.setAttribute('data-node-skin', fam);
    document.documentElement.setAttribute('data-panel-skin', fam);
  }
  updateThemePanelUI();
}

// 控制台兼容（node-skins.md 真机自验口径沿用）：setNodeSkin('key') 现在等价换整个家族
function setNodeSkin(key) {
  applyStyleFamily(key);
}

// 深浅独立开关（2026-10-02 第三轮）：开＝两侧家族键从当前共享值落种（此前从未分过，两侧同源）；
// 关＝收拢为当前模式的主题（壁纸两侧同写、家族共享键取当前侧分键值再摘分键）——否则关掉后
// 另一侧会悄悄变回旧选择，违背「默认共用」的直觉。纯存储操作＋属性重挂，视觉即切。
function setThemeSplit(on) {
  if (on) {
    let fam = null;
    try { fam = localStorage.getItem(STORAGE_KEY_STYLE_FAMILY); } catch (e) {}
    if (!STYLE_FAMILIES.some(f => f.key === fam)) fam = currentStyleFamily();
    try {
      localStorage.setItem(STORAGE_KEY_THEME_SPLIT, '1');
      localStorage.setItem(STORAGE_KEY_STYLE_FAMILY_DARK, fam);
      localStorage.setItem(STORAGE_KEY_STYLE_FAMILY_LIGHT, fam);
    } catch (e) {}
  } else {
    try { localStorage.setItem(STORAGE_KEY_THEME_SPLIT, '0'); } catch (e) {}
    const t = currentTheme === 'light' ? 'light' : 'dark';
    const id = getWallpaperId(t);
    setWallpaper(id, 'dark');
    setWallpaper(id, 'light');
    let fam = null;
    try { fam = localStorage.getItem(_familyModeKey(t)); } catch (e) {}
    if (!STYLE_FAMILIES.some(f => f.key === fam)) fam = currentStyleFamily();
    try {
      localStorage.setItem(STORAGE_KEY_STYLE_FAMILY, fam);
      localStorage.removeItem(STORAGE_KEY_STYLE_FAMILY_DARK);
      localStorage.removeItem(STORAGE_KEY_STYLE_FAMILY_LIGHT);
    } catch (e) {}
  }
  applyStyleFamily(currentStyleFamily());
  renderThemePanel();
}

function updateThemePanelUI() {
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  const cur = currentStyleFamily();
  panel.querySelectorAll('.level-option[data-family]').forEach(el => {
    el.classList.toggle('active', el.dataset.family === cur);
  });
  const curWp = getWallpaperId(currentTheme);
  panel.querySelectorAll('.bg-option[data-id]').forEach(el => {
    el.classList.toggle('active', el.dataset.id === curWp);
  });
}

// 启动即归位：把迁移结果落键＋属性对齐（幂等；updateThemePanelUI 在面板未建时静默返回）
applyStyleFamily(currentStyleFamily());

// ====== 壁纸挑选（成对主题背景，2026-10-02）======
// 深浅模式各记各的选择（phymathia_bg_dark / _bg_light），切主题时 _desiredBgUrl 按
// currentTheme 取对应模式的所选；非法/缺失 id 一律回退首套（内置星夜）。
function getWallpaperId(theme) {
  let id = null;
  try { id = localStorage.getItem(theme === 'light' ? STORAGE_KEY_BG_LIGHT : STORAGE_KEY_BG_DARK); } catch (e) {}
  return WALLPAPER_SETS.some(s => s.id === id) ? id : WALLPAPER_SETS[0].id;
}
function setWallpaper(id, theme) {
  const t = theme || currentTheme;
  if (!WALLPAPER_SETS.some(s => s.id === id)) return false;
  try { localStorage.setItem(t === 'light' ? STORAGE_KEY_BG_LIGHT : STORAGE_KEY_BG_DARK, id); } catch (e) {}
  if (t === currentTheme) {
    updateBgImage();
    // 换套＝符号密度/配色跟着换（2026-10-02 用户拍板：数量随主题，素纸多/星夜少）
    if (typeof window.__syncFloatingSymbols === 'function') window.__syncFloatingSymbols();
  }
  return true;
}
function currentWallpaperSet() {
  const id = getWallpaperId(currentTheme);
  return WALLPAPER_SETS.find(s => s.id === id) || WALLPAPER_SETS[0];
}
// 当前模式的壁纸套 → 默认风格家族（缺行安全回落 aurora）
function themeDefaultFamily() {
  return THEME_DEFAULT_FAMILY[getWallpaperId(currentTheme)] || STYLE_FAMILIES[0].key;
}
// 主题挑选器（2026-10-02 第二轮：吸收原壁纸挑选器＋皮肤面板，顶栏 13→9 的合并位）。
// 上半区三张壁纸主题卡、下半区风格家族五选一（当前主题默认族带★）。
// 点主题卡＝换壁纸＋风格重置默认（Q2 拍板「切主题＝全套重置」）；点风格＝只换族不动壁纸。
// 复用 .level-panel 定位/玻璃材质与 .bg-panel 卡片样式：互斥、外点关闭、按触发钮重定位。
function toggleThemePicker(e) {
  e?.stopPropagation();
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  const willShow = !panel.classList.contains('show');
  _closeHeaderMenus();
  panel.classList.toggle('show');
  const trigger = e && e.currentTarget ? e.currentTarget : document.getElementById('themePickBtn');
  _setPanelTriggerState('themePanel', willShow);
  if (willShow) {
    renderThemePanel(); // 每次打开都重画：缩略图/高亮/默认族星标跟随当前模式（同 renderModelList 时机口径）
    ['levelPanel', 'modelPanel', 'dataPanel'].forEach(id => {
      const p = document.getElementById(id);
      if (p) p.classList.remove('show');
      _setPanelTriggerState(id, false);
    });
    void panel.offsetHeight;
    _positionPanel('themePanel', trigger);
  }
}
function renderThemePanel() {
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  const isLight = currentTheme === 'light';
  const modeName = isLight ? '浅色' : '深色';
  const curId = getWallpaperId(currentTheme);
  const curFam = currentStyleFamily();
  const defFam = themeDefaultFamily();
  const split = themeSplitEnabled();
  let html = '<div class="bg-panel-title">主题 · ' + modeName + '模式' + (split ? '（独立）' : '') + '</div><div class="bg-panel-list">';
  for (const s of WALLPAPER_SETS) {
    const thumb = (isLight ? s.light : s.dark).land;
    html += '<button type="button" class="bg-option' + (s.id === curId ? ' active' : '') + '" data-id="' + s.id + '" title="换壁纸＋把风格重置为该主题的默认搭配" onclick="pickTheme(\'' + s.id + '\')">'
      + '<span class="bg-option-thumb" style="background-image:url(\'' + thumb + '\')"></span>'
      + '<span class="bg-option-name">' + s.name + '</span>'
      + (s.id === curId ? '<svg class="bg-option-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '')
      + '</button>';
  }
  html += '</div>'
    // 深浅独立开关行（2026-10-02 第三轮）：stopPropagation 压住 click 冒泡——onchange 里
    // renderThemePanel 整板重画后，旧 e.target 已脱离面板，外点关闭监听会误判「点了外面」
    + '<label class="theme-split-row"><input type="checkbox"' + (split ? ' checked' : '')
    + ' onchange="event.stopPropagation(); setThemeSplit(this.checked)"><span>深浅模式各自挑主题</span></label>'
    + '<div class="bg-panel-title theme-style-title">风格 · 面板与节点同进退</div><div class="bg-panel-list theme-style-list">';
  for (const f of STYLE_FAMILIES) {
    html += '<div class="level-option' + (f.key === curFam ? ' active' : '') + '" data-family="' + f.key + '" title="' + escapeHtml(f.desc || '') + '" onclick="pickStyleFamily(\'' + f.key + '\')">'
      + '<span class="level-emoji">' + SKIN_OPTION_ICON + '</span> ' + escapeHtml(f.label)
      + (f.key === defFam ? '<span class="theme-default-star" title="当前主题默认">★</span>' : '')
      + '</div>';
  }
  html += '</div>';
  panel.innerHTML = html;
}
function pickTheme(id) {
  if (!setWallpaper(id)) return;
  if (!themeSplitEnabled()) {
    // 默认深浅共用同一主题（2026-10-02 第三轮拍板）：另一侧同步同值，翻深浅不换主题。
    // 读侧按模式取键，联动全靠这里双写；独立模式下不写，另一侧保持自己的选择。
    setWallpaper(id, currentTheme === 'light' ? 'dark' : 'light');
  }
  applyStyleFamily(THEME_DEFAULT_FAMILY[id] || STYLE_FAMILIES[0].key); // 全套重置到默认搭配
  renderThemePanel();
}
function pickStyleFamily(key) {
  applyStyleFamily(key);
  renderThemePanel();
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('themePanel');
  const btn = document.getElementById('themePickBtn');
  if (panel && !panel.contains(e.target) && !(btn && btn.contains(e.target))) {
    panel.classList.remove('show');
    _setPanelTriggerState('themePanel', false);
  }
});

/* ====== 顶栏收纳小菜单（知识/更多，2026-10-02 桌面主栏 13→9）======
 * 静态内容面板（index.html 里写死行），只做开合/互斥/定位；行点击先 stopPropagation
 * 再调原入口（否则 dataPanel 的外点关闭监听会在同一冒泡里把刚打开的面板立刻关掉）。 */
const HEADER_MENUS = ['knowledgeMenu', 'moreMenu'];
function _closeHeaderMenus(except) {
  for (const id of HEADER_MENUS) {
    if (id === except) continue;
    const p = document.getElementById(id);
    if (p) p.classList.remove('show');
    _setPanelTriggerState(id, false);
  }
}
function _toggleHeaderMenu(id, e) {
  e?.stopPropagation();
  const panel = document.getElementById(id);
  if (!panel) return;
  const willShow = !panel.classList.contains('show');
  _closeHeaderMenus(id);
  panel.classList.toggle('show');
  _setPanelTriggerState(id, willShow);
  if (willShow) {
    ['levelPanel', 'modelPanel', 'dataPanel', 'themePanel'].forEach(pid => {
      const p = document.getElementById(pid);
      if (p) p.classList.remove('show');
      _setPanelTriggerState(pid, false);
    });
    void panel.offsetHeight;
    _positionPanel(id, e && e.currentTarget ? e.currentTarget : document.querySelector('[aria-controls="' + id + '"]'));
  }
}
/* 知识菜单「知识检测」二级子菜单（2026-10-03）：悬停展开是纯 CSS（.menu-submenu-host:hover），
   这里只负责触屏点击兜底，以及两处关菜单路径（closeKnowledgeMenu／外点关闭）收起 .open 防残留。 */
function _closeKnowledgeQuizSubmenu() {
  const sm = document.getElementById('knowledgeQuizSubmenu');
  if (sm) sm.classList.remove('open');
}
function toggleKnowledgeQuizSubmenu(e) {
  e?.stopPropagation();
  const sm = document.getElementById('knowledgeQuizSubmenu');
  if (sm) sm.classList.toggle('open');
}
function toggleKnowledgeMenu(e) { _toggleHeaderMenu('knowledgeMenu', e); }
function closeKnowledgeMenu() { _closeHeaderMenus(); _closeKnowledgeQuizSubmenu(); }
function toggleMoreMenu(e) { _toggleHeaderMenu('moreMenu', e); }
function closeMoreMenu() { _closeHeaderMenus(); }
document.addEventListener('click', (e) => {
  for (const id of HEADER_MENUS) {
    const panel = document.getElementById(id);
    if (!panel || !panel.classList.contains('show')) continue;
    const btn = document.querySelector('[aria-controls="' + id + '"]');
    if (!panel.contains(e.target) && !(btn && btn.contains(e.target))) {
      panel.classList.remove('show');
      _setPanelTriggerState(id, false);
      if (id === 'knowledgeMenu') _closeKnowledgeQuizSubmenu();
    }
  }
});

/* ====================================================
 * 鼠标特效系统
 * 点击溅射（桌面+移动端）
 * ==================================================== */
(function initMouseEffects() {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  let mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
  let lastMX = mouseX, lastMY = mouseY;

  // ── 点击溅射 ──
  const canvas = document.getElementById('particleCanvas');
  const ctx = canvas.getContext('2d');
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const particles = [];
  const MAX_PARTICLES = isMobile ? 80 : 150;

  class Particle {
    constructor(x, y, vx, vy, gravity = 0.02) {
      this.x = x; this.y = y;
      this.vx = vx; this.vy = vy;
      this.gravity = gravity;
      this.life = 1.0;
      this.decay = isMobile ? 0.015 + Math.random() * 0.018 : 0.010 + Math.random() * 0.012;
      this.size = isMobile ? 0.8 + Math.random() * 1.2 : 1.0 + Math.random() * 1.5;
      const dark = currentTheme !== 'light';
      if (dark) {
        const hue = 220 + Math.random() * 60;
        this.color = `hsla(${hue}, 80%, 75%,`;
      } else {
        const hue = 25 + Math.random() * 25;
        this.color = `hsla(${hue}, 65%, 60%,`;
      }
    }
    update() {
      this.vy += this.gravity;
      this.x += this.vx;
      this.y += this.vy;
      this.vx *= 0.985;
      this.life -= this.decay;
    }
    draw(ctx) {
      if (this.life <= 0) return;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
      ctx.fillStyle = this.color + (this.life * 0.6) + ')';
      ctx.fill();
    }
  }

  // 粒子循环按需启停：每帧一次全屏 clearRect，粒子为空时这一帧不产出任何可见物，
  // 却照烧 CPU/电量——数组清空即不再排下一帧，下次 burst 再重启（溅射是唯一生成点）。
  let _particleRaf = 0;
  function animateParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = particles.length - 1; i >= 0; i--) {
      particles[i].update();
      particles[i].draw(ctx);
      if (particles[i].life <= 0) particles.splice(i, 1);
    }
    if (particles.length > 0) {
      _particleRaf = requestAnimationFrame(animateParticles);
    } else {
      _particleRaf = 0;
    }
  }
  function ensureParticleLoop() {
    if (!_particleRaf) _particleRaf = requestAnimationFrame(animateParticles);
  }

  // 点击/触摸爆发溅射
  const burstCount = isMobile ? 8 : 14;
  function burstAt(x, y) {
    ensureParticleLoop();
    for (let i = 0; i < burstCount; i++) {
      if (particles.length >= MAX_PARTICLES) {
        const oldest = particles.findIndex(p => p.life <= 0);
        if (oldest >= 0) particles.splice(oldest, 1);
        else particles.shift();
      }
      const angle = (Math.PI * 2 / burstCount) * i + (Math.random() - 0.5) * 0.5;
      const v = 0.5 + Math.random() * 1.5;
      particles.push(new Particle(
        x + (Math.random() - 0.5) * 4,
        y + (Math.random() - 0.5) * 4,
        Math.cos(angle) * v,
        Math.sin(angle) * v - 0.5,
        0.03
      ));
    }
  }
  document.addEventListener('click', (e) => burstAt(e.clientX, e.clientY));
  if (isMobile) {
    document.addEventListener('touchend', (e) => {
      if (e.changedTouches && e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        burstAt(t.clientX, t.clientY);
      }
    }, { passive: true });
  }

  // ── 鼠标移动统一监听（仅桌面） ──
  if (!isMobile) {
    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      lastMX = mouseX;
      lastMY = mouseY;
    });
  }
})();
