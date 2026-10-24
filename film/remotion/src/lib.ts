import { Easing, interpolate, spring } from 'remotion';

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** clamped interpolate with easing */
export const $ = (
  f: number,
  a: number,
  b: number,
  x = 0,
  y = 1,
  ease: (t: number) => number = Easing.inOut(Easing.cubic)
) =>
  interpolate(f, [a, b], [x, y], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });

export const $out = (f: number, a: number, b: number, x = 0, y = 1) =>
  $(f, a, b, x, y, Easing.out(Easing.cubic));
export const $exp = (f: number, a: number, b: number, x = 0, y = 1) =>
  $(f, a, b, x, y, Easing.out(Easing.exp));
export const $in = (f: number, a: number, b: number, x = 0, y = 1) =>
  $(f, a, b, x, y, Easing.in(Easing.cubic));

export const spr = (f: number, start: number, fps: number, cfg: Record<string, number> = {}) =>
  spring({
    frame: f - start,
    fps,
    config: { damping: 16, mass: 0.55, stiffness: 180, ...cfg },
  });

/** exponential decay envelope after a hit */
export const decay = (f: number, at: number, tau: number) =>
  f < at ? 0 : Math.exp(-(f - at) / tau);

export const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>/\\|ΣΔΦΩ∂∇≠≈';

export const typed = (f: number, start: number, text: string, fpc = 3) => {
  const n = Math.floor((f - start) / fpc);
  return text.slice(0, Math.max(0, Math.min(text.length, n)));
};

/** scramble-then-lock text */
export const decrypt = (f: number, start: number, text: string, fpc = 4, seed = 0) =>
  text
    .split('')
    .map((ch, i) => {
      if (ch === ' ') return ' ';
      if (f >= start + i * fpc) return ch;
      if (f < start) return ' ';
      const gi = Math.floor(hash(seed + i * 13.7 + Math.floor(f / 2)) * GLYPHS.length);
      return GLYPHS[gi];
    })
    .join('');

type Pt = [number, number];

export const wavePoints = (n: number, amp: number, w: number, h: number, samples = 140, phase = 0): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    pts.push([t * w, h / 2 - amp * Math.sin(n * Math.PI * t + phase)]);
  }
  return pts;
};

export const polyline = (pts: Pt[]) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');

export const smoothClosed = (pts: Pt[]) => {
  const n = pts.length;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = '';
  const m0 = mid(pts[n - 1], pts[0]);
  d += `M${m0[0].toFixed(2)} ${m0[1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const m = mid(p, pts[(i + 1) % n]);
    d += `Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${m[0].toFixed(2)} ${m[1].toFixed(2)}`;
  }
  return d + 'Z';
};

/** organic island outline */
export const blobPoints = (
  cx: number,
  cy: number,
  r: number,
  seed: number,
  points = 44,
  irr = 0.3
): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const k =
      1 +
      irr * 0.55 * Math.sin(3 * a + seed) +
      irr * 0.3 * Math.sin(5 * a + seed * 2.3) +
      irr * 0.18 * Math.sin(8 * a + seed * 4.1);
    pts.push([cx + Math.cos(a) * r * k * 1.35, cy + Math.sin(a) * r * k * 0.82]);
  }
  return pts;
};

export const fmt = (n: number, len = 2) => String(Math.floor(n)).padStart(len, '0');

export const timecode = (f: number, fps = 30) => {
  const s = f / fps;
  return `${fmt(Math.floor(s / 60))}:${fmt(Math.floor(s % 60))}:${fmt(f % fps)}`;
};
