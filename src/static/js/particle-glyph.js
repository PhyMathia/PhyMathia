// ====== 进度胶囊状态图标：105 点粒子动画（2026-11-18，按 ZCode「工作中」图标复刻） ======
// 来源＝ZCode 客户端 app.asar 里 mun 组件的逆向还原（情报包 outputs/ZCode粒子动画-复刻情报.md，
// 逐行对照版 outputs/zcode-particle-demo.html）。本体是一个 20×20 的 SVG：105 个 <circle>
// 在「斐波那契球面」与「60 点点阵」之间 morph，同时阵列绕 Y 轴 2.5s 转一圈。
// ★ 与原组件的唯一差异（2026-11-18 用户拍板）：聚成的字形不是字母 Z，而是本应用的 Φ——
//   Z 是 ZCode 的品牌符号，挂在别的产品上只会读成「别人的 logo」。除点阵目标外一律照抄。
//   Φ 的笔画宽度由点阵本身撑开（双环＋竖笔双列），不是靠放大单点半径——单列点阵在 20px
//   下只有 1px 宽、读起来像虚线（2026-11-18 用户第二次口径）。
// 一个周期 8240ms：0–5000 球体旋转 → 5000–6296 聚成 Φ（easeInOutCubic＋逐点错峰 0.06）
// → 6296–7160 Φ 保持 → 7160–7952 散回球体 → 7952–8240 空转。
// 三个必须照抄、漏了就不像的细节：
//   ① 球体态只有 n%3===0 的点有亮度（0.35+0.6·depth，depth 是旋转后的 Z 深度），其余靠 Φ 态显形；
//   ② morph 位移带切向摆动 sin(π·gs)·0.45·±1 ——「被甩过去」的观感全在这一项；
//   ③ 自转角取绝对时钟（now/2500），morph 进度取相对时钟（(now−t0)%8240）；两者不同源，
//      所以胶囊反复显隐时球体不跳相，只有 morph 从头来。
// 口径（2026-11-18 用户拍板）：这是**小图标**，不是背景粒子。上一版把 canvas 铺在胶囊底下
// 当背景，方向本身就错了（且 .aurora-glass 带 backdrop-filter 时软件合成下整块不渲染）。
// 与 .status-dot 二选一：胶囊 .active（进行中）时点阵接管，待命/终态仍是那颗 6px 圆点。
// 冒烟沙箱兼容：document/window 是宽松代理——构造 DOM 只走 createElementNS/setAttribute，
// 全部被吸收；requestAnimationFrame 是空桩，帧循环不会真跑。纯函数 phyGlyphFrameAt
// 给沙箱留了确定性入口（周期内毫秒与自转时钟都显式传入）。

// Φ 的点阵（60 点）：圆环用内外两圈点撑出笔画宽度——内圈 20 点（半径 4.9、起始 9°）、
// 外圈 24 点（半径 5.9、起始 7.5°），两圈错开半个弧距；中轴竖笔 2 列 × 8 行
// （x=10±0.55，y=3..17 每 2 格），宽度也是两粒，与环带一致。两圈起始角都避开 90°/270°，
// 环点不会压到竖笔上；竖笔上下各探出环外约 1.1 格。
const PHY_GLYPH_MARK_DOTS = (() => {
  const dots = [];
  for (let i = 0; i < 20; i++) {
    const a = (9 + i * 18) * Math.PI / 180;   // 内圈：18° 一格，共 20 点
    dots.push([10 + 4.9 * Math.cos(a), 10 + 4.9 * Math.sin(a)]);
  }
  for (let i = 0; i < 24; i++) {
    const a = (7.5 + i * 15) * Math.PI / 180; // 外圈：15° 一格，共 24 点
    dots.push([10 + 5.9 * Math.cos(a), 10 + 5.9 * Math.sin(a)]);
  }
  for (const x of [9.45, 10.55]) {
    for (let y = 3; y <= 17; y += 2) dots.push([x, y]);
  }
  return dots;
})();
const PHY_GLYPH_COUNT = 105;
const PHY_GLYPH_PERIOD = 8240;
const PHY_GLYPH_T_MORPH = 5000;   // 球体 → 字形起跑
const PHY_GLYPH_T_HOLD = 6296;    // 字形到位
const PHY_GLYPH_T_BACK = 7160;    // 字形 → 球体起跑
const PHY_GLYPH_T_REST = 7952;    // 散回球体完成
const PHY_GLYPH_SPIN_MS = 2500;   // 自转一圈
const PHY_GLYPH_RADIUS = 8.5;     // 20×20 viewBox 内的球半径
const PHY_GLYPH_DOT_R = 0.5;       // 球体/字形粒子半径（照抄原组件，宽度靠点阵不靠半径）
const PHY_GLYPH_FRAME_MS = 22;    // 帧率上限 ≈45fps（每帧最多 ~75 个点 × 3 个属性）

// 字形点 → 粒子索引：60 个点按比例均匀撒进 105 个索引，没被点到的粒子在字形态透明。
const PHY_GLYPH_MARK_INDEX = new Map(
  PHY_GLYPH_MARK_DOTS.map((p, i) => [Math.floor(i * PHY_GLYPH_COUNT / PHY_GLYPH_MARK_DOTS.length), p])
);
// 斐波那契球面单位向量（黄金角螺旋，点数决定形状，别改 105）。
const PHY_GLYPH_SPHERE = Array.from({ length: PHY_GLYPH_COUNT }, (_, i) => {
  const y = 1 - i / (PHY_GLYPH_COUNT - 1) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = Math.PI * (3 - Math.sqrt(5)) * i;
  return [Math.cos(phi) * r, y, Math.sin(phi) * r];
});

// 活跃实例表＋共享帧循环句柄（所有 glyph 共用一条 rAF，没有活跃实例就停表）
const PHY_GLYPH_RUNNING = new Set();
let PHY_GLYPH_LOOP_ID = 0;
let PHY_GLYPH_LAST_TICK = 0;

function phyGlyphEase(x) {
  return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// morph 进度 s：0＝球体、1＝字形（与原组件 tick 里的四段判断逐字一致）
function phyGlyphMorphAt(t) {
  const ms = Number(t) || 0;
  if (ms < PHY_GLYPH_T_MORPH) return 0;
  if (ms < PHY_GLYPH_T_HOLD) return phyGlyphEase((ms - PHY_GLYPH_T_MORPH) / (PHY_GLYPH_T_HOLD - PHY_GLYPH_T_MORPH));
  if (ms < PHY_GLYPH_T_BACK) return 1;
  if (ms < PHY_GLYPH_T_REST) return 1 - phyGlyphEase((ms - PHY_GLYPH_T_BACK) / (PHY_GLYPH_T_REST - PHY_GLYPH_T_BACK));
  return 0;
}

// 纯函数：给定「周期内已过毫秒 t」与「自转绝对时钟 spinMs」，算出 105 个点的 [x, y, opacity]。
// 沙箱与调试用它定格任意一帧（demo 页的拖动时间轴就是这个函数的可视化）。
function phyGlyphFrameAt(t, spinMs) {
  const s = phyGlyphMorphAt(t);
  const ang = (Number(spinMs) || 0) / PHY_GLYPH_SPIN_MS * Math.PI * 2;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const pts = new Array(PHY_GLYPH_COUNT);
  for (let n = 0; n < PHY_GLYPH_COUNT; n++) {
    const v = PHY_GLYPH_SPHERE[n];
    // 球体点绕 Y 轴转，再正交投影到 20×20 画布（中心 10,10，半径 8.5）
    const fx = 10 + PHY_GLYPH_RADIUS * (v[0] * cos + v[2] * sin);
    const fy = 10 - PHY_GLYPH_RADIUS * v[1];
    const depth = (-v[0] * sin + v[2] * cos + 1) / 2;
    const base = n % 3 === 0 ? .35 + .6 * depth : 0;
    const mark = PHY_GLYPH_MARK_INDEX.get(n);
    // 逐点错峰 ±0.03：同一时刻各点进度略有差异，聚散才有「波浪」而不是硬切
    const gs = (s === 0 || s === 1) ? s
      : Math.max(0, Math.min(1, s + (n / PHY_GLYPH_COUNT - .5) * .06));
    const tx = mark ? mark[0] : fx, ty = mark ? mark[1] : fy;
    const dx = tx - fx, dy = ty - fy;
    const dist = Math.hypot(dx, dy) || 1;
    const swirl = Math.sin(Math.PI * gs) * .45 * (n % 2 ? 1 : -1);
    const opacity = base + ((mark ? 1 : 0) - base) * gs;
    pts[n] = [fx + dx * gs - dy / dist * swirl, fy + dy * gs + dx / dist * swirl, opacity];
  }
  return { s: s, pts: pts };
}

function phyGlyphNow() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();
}

// 只读元数据口（冒烟/调试用）：常量与两组坐标都是「改了一处就必须同步」的契约，
// 暴露出来让用例断言精确值，而不是在测试里再抄一份点阵。
function phyGlyphMeta() {
  return {
    count: PHY_GLYPH_COUNT,
    period: PHY_GLYPH_PERIOD,
    spinMs: PHY_GLYPH_SPIN_MS,
    radius: PHY_GLYPH_RADIUS,
    dotR: PHY_GLYPH_DOT_R,
    timeline: [PHY_GLYPH_T_MORPH, PHY_GLYPH_T_HOLD, PHY_GLYPH_T_BACK, PHY_GLYPH_T_REST],
    markDots: PHY_GLYPH_MARK_DOTS,
    markIndexOf: (n) => PHY_GLYPH_MARK_INDEX.get(n),
    sphere: PHY_GLYPH_SPHERE,
  };
}

// 一组 glyph 共用一条 rAF：没有活跃实例就停表，帧率封在 ~45fps（45 次/秒的点写入在
// 画布流式渲染旁边完全不占光，60fps 的收益肉眼看不见）。
function phyGlyphTick(now) {
  if (!PHY_GLYPH_RUNNING.size) { PHY_GLYPH_LOOP_ID = 0; return; }
  PHY_GLYPH_LOOP_ID = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(phyGlyphTick) : 0;
  if (now - PHY_GLYPH_LAST_TICK < PHY_GLYPH_FRAME_MS) return;
  PHY_GLYPH_LAST_TICK = now;
  Array.from(PHY_GLYPH_RUNNING).forEach(ctl => ctl._paint(now));
}

function phyGlyphReducedMotion() {
  try {
    if (typeof matchMedia !== 'function') return false;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    return !!(mq && mq.matches);
  } catch (e) { return false; }
}

// 在容器里建一个 glyph，返回 { start, stop, destroy, paintAt }。
// 数据侧预计算：每点只留不变的东西（Φ 位判定、上次写入的透明度），帧内只做算术＋写属性。
function phyParticleGlyphMount(container) {
  if (!container || typeof document === 'undefined' || typeof document.createElementNS !== 'function') return null;
  if (container._phyGlyph) return container._phyGlyph;   // 幂等：重复挂载复用同一实例
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('fill', 'currentColor');
  // 极淡的一圈辉光，让 0.5 单位的点在 20px 尺寸下不糊成一粒灰——配方照抄原组件
  g.style.filter = 'drop-shadow(0 0 0.2px color-mix(in srgb, currentColor 25%, transparent))';
  const circles = new Array(PHY_GLYPH_COUNT);
  const parts = new Array(PHY_GLYPH_COUNT);
  for (let n = 0; n < PHY_GLYPH_COUNT; n++) {
    const mark = PHY_GLYPH_MARK_INDEX.get(n);
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', mark ? mark[0] : 10);
    c.setAttribute('cy', mark ? mark[1] : 10);
    c.setAttribute('r', PHY_GLYPH_DOT_R);
    c.setAttribute('opacity', mark ? 1 : 0);
    g.appendChild(c);
    circles[n] = c;
    // never＝任何 s 都不亮（非字形位且不是 n%3===0）：位置照算但不写 DOM，省掉约四成属性写入
    parts[n] = { never: !mark && n % 3 !== 0, lastOp: -1 };
  }
  svg.appendChild(g);
  container.appendChild(svg);

  let t0 = 0;
  let running = false;

  function paintAt(t, spinMs) {
    const frame = phyGlyphFrameAt(t, spinMs);
    for (let n = 0; n < PHY_GLYPH_COUNT; n++) {
      const part = parts[n];
      if (part.never) continue;
      const p = frame.pts[n];
      const c = circles[n];
      c.setAttribute('cx', p[0].toFixed(2));
      c.setAttribute('cy', p[1].toFixed(2));
      // 透明度只在不变化时不写（球体态下大半粒子恒 0，写了也是白写）
      const op = Math.round(p[2] * 100) / 100;
      if (op !== part.lastOp) { c.setAttribute('opacity', op.toFixed(2)); part.lastOp = op; }
    }
  }

  const ctl = {
    el: svg,
    // 调试/冒烟入口：定格任意一帧（t 在周期内，spinMs 为自转时钟）
    paintAt: paintAt,
    paintStaticMark() { paintAt(PHY_GLYPH_T_HOLD, 0); },
    _paint(now) {
      const t = (((now - t0) % PHY_GLYPH_PERIOD) + PHY_GLYPH_PERIOD) % PHY_GLYPH_PERIOD;
      paintAt(t, now);
    },
    start() {
      // 减少动态：直接停在字形态，不跑 rAF（与官方组件同口径）
      if (phyGlyphReducedMotion()) { ctl.paintStaticMark(); return; }
      if (!running) {
        // 新一轮从球体相位起跑：每次「开始干活」都先看球转、再聚成字形
        t0 = phyGlyphNow();
        running = true;
        for (let n = 0; n < PHY_GLYPH_COUNT; n++) parts[n].lastOp = -1;
        ctl._paint(t0);
      }
      PHY_GLYPH_RUNNING.add(ctl);
      if (!PHY_GLYPH_LOOP_ID && typeof requestAnimationFrame === 'function') {
        PHY_GLYPH_LOOP_ID = requestAnimationFrame(phyGlyphTick);
      }
    },
    stop() {
      running = false;
      PHY_GLYPH_RUNNING.delete(ctl);
    },
    destroy() {
      ctl.stop();
      if (svg.parentNode && svg.parentNode.removeChild) svg.parentNode.removeChild(svg);
      if (container._phyGlyph === ctl) container._phyGlyph = null;
    }
  };
  container._phyGlyph = ctl;
  return ctl;
}

// 接线：胶囊 .active 一挂上就转，一摘就停。
// .active 有三个写入方（chat.js 的 showProgress/hideProgress/setProgressTerminal、
// send-queue.js 的排队章保活），逐处手接必然漏分叉——观察这一个元素的 class 最省心。
function phyGlyphInitStatusIcon() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
  const box = document.getElementById('statusGlyph');
  const capsule = document.getElementById('progressStatus');
  if (!box || !capsule) return null;
  const ctl = phyParticleGlyphMount(box);
  if (!ctl) return null;
  const sync = () => {
    const active = !!(capsule.classList && capsule.classList.contains('active'));
    if (active) ctl.start(); else ctl.stop();
  };
  sync();
  try {
    if (typeof MutationObserver === 'function') {
      new MutationObserver(sync).observe(capsule, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) {}
  return ctl;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', phyGlyphInitStatusIcon);
  } else {
    phyGlyphInitStatusIcon();
  }
}

window.phyParticleGlyphMount = phyParticleGlyphMount;
window.phyGlyphFrameAt = phyGlyphFrameAt;
window.phyGlyphInitStatusIcon = phyGlyphInitStatusIcon;
