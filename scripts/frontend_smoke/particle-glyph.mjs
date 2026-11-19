// 进度胶囊「工作中」粒子图标（particle-glyph.js，2026-11-18）契约与行为。
// 范围：105 点/8240ms/2.5s 自转三个常量、四段 morph 时间轴、Φ 点阵与映射、
// 球体投影与明暗规则（只有 n%3===0 有亮度）、切向摆动项、DOM 构造（105 个 circle）
// 与 .active 接线。全部同步：DOM 断言自带 createElementNS 记录桩，用毕还原。
import { check, sandbox, fs, bundleChunk } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);

// 假的 SVG 文档工厂：记录每个被创建的元素与属性，供「建了几个 circle、写了什么值」断言。
function fakeSvgDoc() {
  const created = [];
  const make = (tag) => {
    const el = {
      tagName: tag,
      attrs: {},
      children: [],
      parentNode: null,
      style: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
    };
    created.push(el);
    return el;
  };
  return { make, created };
}

export function run() {
  check('particle-glyph: 105 点 / 8240ms / 2.5s 自转 / 60 个 Φ 点映射均匀（双环＋双列竖笔）', () => {
    const meta = sandbox.phyGlyphMeta();
    if (meta.count !== 105) throw new Error('粒子数应为 105，实为 ' + meta.count);
    if (meta.period !== 8240) throw new Error('周期应为 8240ms，实为 ' + meta.period);
    if (meta.spinMs !== 2500) throw new Error('自转一圈应为 2500ms，实为 ' + meta.spinMs);
    if (Math.abs(meta.radius - 8.5) > 1e-9) throw new Error('球半径应为 8.5，实为 ' + meta.radius);
    if (!near(meta.dotR, 0.5)) throw new Error('点半径应为 0.5（宽度靠点阵不靠半径），实为 ' + meta.dotR);
    const tl = meta.timeline.join(',');
    if (tl !== '5000,6296,7160,7952') throw new Error('四段 morph 时间轴被改动：' + tl);
    if (meta.markDots.length !== 60) throw new Error('字形点阵应为 60 个，实为 ' + meta.markDots.length);
    // 60 个字形点按 floor(i*105/60) 撒进 105 个索引：必须互不重复且落在 0..104
    const hits = [];
    for (let n = 0; n < meta.count; n++) if (meta.markIndexOf(n)) hits.push(n);
    if (hits.length !== 60) throw new Error('映射后应命中 60 个粒子，实为 ' + hits.length);
    for (let i = 0; i < 60; i++) {
      const n = Math.floor(i * 105 / 60);
      const m = meta.markIndexOf(n);
      if (!m || m[0] !== meta.markDots[i][0] || m[1] !== meta.markDots[i][1]) {
        throw new Error('第 ' + i + ' 个字形成员没落在索引 ' + n + ' 上（映射公式漂了）');
      }
    }
    // 字形是 Φ：0–19 内环（r=4.9）、20–43 外环（r=5.9）、44–59 双列竖笔（x=10±0.55）
    for (let i = 0; i < 20; i++) {
      const [x, y] = meta.markDots[i];
      if (!near(Math.hypot(x - 10, y - 10), 4.9, 1e-9)) throw new Error('Φ 内环第 ' + i + ' 点不在半径 4.9 上');
      if (Math.abs(x - 10) < 0.5) throw new Error('Φ 内环第 ' + i + ' 点压在中轴上（起始角 9° 没生效）');
    }
    for (let i = 20; i < 44; i++) {
      const [x, y] = meta.markDots[i];
      if (!near(Math.hypot(x - 10, y - 10), 5.9, 1e-9)) throw new Error('Φ 外环第 ' + i + ' 点不在半径 5.9 上');
      if (Math.abs(x - 10) < 0.5) throw new Error('Φ 外环第 ' + i + ' 点压在中轴上（起始角 7.5° 没生效）');
    }
    for (let i = 44; i < 60; i++) {
      const [x, y] = meta.markDots[i];
      const col = i < 52 ? 9.45 : 10.55;
      const row = i < 52 ? i - 44 : i - 52;
      if (!near(x, col, 1e-9) || !near(y, 3 + row * 2, 1e-9)) {
        throw new Error('Φ 竖笔第 ' + i + ' 点位置不对：(' + x + ',' + y + ')');
      }
    }
    return true;
  });

  check('particle-glyph: 字形保持帧里 60 个可见点精确落在 Φ 点阵上、其余 45 个透明', () => {
    const meta = sandbox.phyGlyphMeta();
    const frame = sandbox.phyGlyphFrameAt(6600, 0); // 6296–7160 = 字形保持段
    if (frame.s !== 1) throw new Error('6600ms 应处在字形保持段（s=1），实为 ' + frame.s);
    let visible = 0;
    for (let n = 0; n < meta.count; n++) {
      const p = frame.pts[n];
      const m = meta.markIndexOf(n);
      if (m) {
        visible++;
        if (!near(p[0], m[0]) || !near(p[1], m[1])) {
          throw new Error('第 ' + n + ' 个粒子没落在字形点 (' + m[0] + ',' + m[1] + ')，实为 (' + p[0] + ',' + p[1] + ')');
        }
        if (!near(p[2], 1)) throw new Error('字形位粒子应完全不透明，实为 ' + p[2]);
      } else if (p[2] !== 0) {
        throw new Error('非字形位粒子应透明，第 ' + n + ' 个 opacity=' + p[2]);
      }
    }
    if (visible !== 60) throw new Error('字形帧应有 60 个可见点，实为 ' + visible);
    return true;
  });

  check('particle-glyph: 球体态全部点在半径 8.5 内、只有每 3 个点亮 1 个、自转 2500ms 回到原样', () => {
    const meta = sandbox.phyGlyphMeta();
    const frame = sandbox.phyGlyphFrameAt(2000, 0); // 0–5000 = 球体旋转段
    if (frame.s !== 0) throw new Error('2000ms 应处在球体段（s=0），实为 ' + frame.s);
    let lit = 0;
    for (let n = 0; n < meta.count; n++) {
      const p = frame.pts[n];
      const dist = Math.hypot(p[0] - 10, p[1] - 10);
      if (dist > meta.radius + 1e-6) throw new Error('第 ' + n + ' 个点跑出球面：距圆心 ' + dist.toFixed(3));
      const isLit = n % 3 === 0;
      if (isLit) {
        lit++;
        // 亮度 = 0.35 + 0.6·depth，depth∈[0,1] → 落在 [0.35, 0.95]
        if (!(p[2] >= 0.35 - 1e-9 && p[2] <= 0.95 + 1e-9)) {
          throw new Error('亮点 ' + n + ' 的透明度越界：' + p[2]);
        }
      } else if (p[2] !== 0) {
        throw new Error('非 3 倍数的点不该有亮度（第 ' + n + ' 个透明度 ' + p[2] + '）');
      }
    }
    if (lit !== 35) throw new Error('105 点里应有 35 个亮点，实为 ' + lit);
    // 自转：同一周期内相差一整圈 → 位置完全一致；差半圈 → 必须不同
    const a = sandbox.phyGlyphFrameAt(2000, 0);
    const b = sandbox.phyGlyphFrameAt(2000, 2500);
    const c = sandbox.phyGlyphFrameAt(2000, 1250);
    for (let n = 0; n < meta.count; n++) {
      if (!near(a.pts[n][0], b.pts[n][0], 1e-9) || !near(a.pts[n][1], b.pts[n][1], 1e-9)) {
        throw new Error('自转 2500ms 应回到同一投影（第 ' + n + ' 个点不一致）');
      }
    }
    let moved = false;
    for (let n = 0; n < meta.count; n++) {
      if (Math.abs(a.pts[n][0] - c.pts[n][0]) > 0.5) { moved = true; break; }
    }
    if (!moved) throw new Error('自转半圈后位置应有明显变化（自转没接上）');
    return true;
  });

  check('particle-glyph: morph 中段带切向摆动（s=0.5 时偏离直线插值 ~0.45）', () => {
    const meta = sandbox.phyGlyphMeta();
    const mid = sandbox.phyGlyphFrameAt(5648, 0); // (6296−5000)/2 → s=ease(0.5)=0.5
    if (!near(mid.s, 0.5, 1e-9)) throw new Error('5648ms 的 morph 进度应为 0.5，实为 ' + mid.s);
    // 同一自转时钟（spin=0）下的球体基准位：s=0 那一帧的坐标就是 morph 起点
    const sphereAt = sandbox.phyGlyphFrameAt(0, 0);
    // 直线上「应到」的位置＝球位 → Φ 点按 gs 线性插值；实际位置与它的偏差就是摆动量
    let maxDev = 0, checked = 0;
    for (let n = 0; n < meta.count; n++) {
      const m = meta.markIndexOf(n);
      if (!m) continue;
      const sPos = sphereAt.pts[n];
      const gs = Math.max(0, Math.min(1, 0.5 + (n / meta.count - 0.5) * 0.06));
      const lx = sPos[0] + (m[0] - sPos[0]) * gs;
      const ly = sPos[1] + (m[1] - sPos[1]) * gs;
      maxDev = Math.max(maxDev, Math.hypot(mid.pts[n][0] - lx, mid.pts[n][1] - ly));
      checked++;
    }
    if (checked !== 60) throw new Error('应检查 60 个字形位粒子，实为 ' + checked);
    // 摆动幅度 = sin(π·gs)·0.45 ≤ 0.45；没有这一项时偏差应恒为 0
    if (!(maxDev > 0.1 && maxDev <= 0.45 + 1e-6)) {
      throw new Error('morph 中段的最大摆动量应为 (0.1, 0.45]，实为 ' + maxDev.toFixed(4));
    }
    return true;
  });

  check('particle-glyph: 建出 20×20 SVG＋105 个 circle，paintAt 写真值，destroy 摘除节点', () => {
    const doc = fakeSvgDoc();
    const prevNS = sandbox.document.createElementNS;
    const container = {
      _phyGlyph: null,
      children: [],
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
    };
    sandbox.document.createElementNS = (ns, tag) => doc.make(tag);
    try {
      const ctl = sandbox.phyParticleGlyphMount(container);
      if (!ctl) throw new Error('mount 返回空');
      const svg = ctl.el;
      if (svg.tagName !== 'svg' || svg.attrs.viewBox !== '0 0 20 20') {
        throw new Error('SVG 根应为 20×20 viewBox，实为 ' + svg.attrs.viewBox);
      }
      const g = svg.children[0];
      if (!g || g.attrs.fill !== 'currentColor') throw new Error('缺 fill=currentColor 的点阵组');
      if (g.children.length !== 105) throw new Error('点阵组里应有 105 个 circle，实为 ' + g.children.length);
      // 笔画宽度必须来自点阵：焊死 0.5 半径，防止又改回「放大单点」
      if (g.children.some((c) => c.attrs.r !== '0.5')) throw new Error('circle 半径应恒为 0.5（宽度靠点阵列）');
      if (svg.children.length !== 1) throw new Error('SVG 根下应只有 1 个子节点');
      if (container.children.length !== 1) throw new Error('未挂到容器上');
      // 幂等：同容器再挂一次复用实例（不会长出第二棵 svg）
      if (sandbox.phyParticleGlyphMount(container) !== ctl) throw new Error('重复挂载应复用同一实例');
      if (container.children.length !== 1) throw new Error('重复挂载长出了第二棵 svg');

      // 定格字形态：60 个 circle 的 opacity 应写成 1.00，且坐标是 Φ 点阵坐标
      ctl.paintAt(6600, 0);
      const visible = g.children.filter((c) => c.attrs.opacity === '1.00');
      if (visible.length !== 60) throw new Error('字形帧应写出 60 个可见点，实为 ' + visible.length);
      const meta = sandbox.phyGlyphMeta();
      const markSet = new Set(meta.markDots.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)));
      for (const c of visible) {
        if (!markSet.has(c.attrs.cx + ',' + c.attrs.cy)) {
          throw new Error('可见点不在 Φ 点阵上：' + c.attrs.cx + ',' + c.attrs.cy);
        }
      }
      // 球体帧：亮起来的是每 3 个点里的 1 个（含字形位），其余保持 0
      ctl.paintAt(2000, 0);
      const litNow = g.children.filter((c) => c.attrs.opacity && c.attrs.opacity !== '0.00');
      if (litNow.length < 28 || litNow.length > 105) throw new Error('球体帧可见点数异常：' + litNow.length);

      ctl.destroy();
      if (container.children.length !== 0) throw new Error('destroy 未摘除 SVG');
      if (container._phyGlyph) throw new Error('destroy 未清实例引用');
      return true;
    } finally {
      sandbox.document.createElementNS = prevNS;
    }
  });

  check('particle-glyph: 胶囊接线（#statusGlyph 在 HTML 里、.active 时点阵接管圆点、进包）', () => {
    const html = readSrc('src/static/index.html');
    if (!/id="statusGlyph"/.test(html)) throw new Error('index.html 缺 #statusGlyph 容器');
    if (!/class="status-glyph"[^>]*id="statusGlyph"/.test(html)) {
      throw new Error('#statusGlyph 的类名不对（CSS 靠 .status-glyph 挂显隐）');
    }
    const css = readSrc('src/static/css/styles.css');
    for (const rule of [
      '.progress-status .status-glyph {',
      '.progress-status.active .status-glyph { display: flex; }',
      '.progress-status.active .status-dot { display: none; }',
    ]) {
      if (!css.includes(rule)) throw new Error('styles.css 缺规则：' + rule);
    }
    // 进包＋观察 .active：观察器是唯一活水口（三处 .active 写入方不必逐处手接）
    const chunk = bundleChunk('particle-glyph.js');
    for (const token of ['phyParticleGlyphMount', 'MutationObserver', "attributeFilter: ['class']", 'prefers-reduced-motion']) {
      if (!chunk.includes(token)) throw new Error('打包块缺关键实现：' + token);
    }
    return true;
  });
}
