import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from '../theme';
import { $, $out, decay, hash, blobPoints, smoothClosed, lerp } from '../lib';

type Isle = { x: number; y: number; r: number; seed: number; name: string; cn: string; main?: boolean };

const ISLES: Isle[] = [
  { x: 372, y: 392, r: 104, seed: 1.3, name: 'ACOUSTICS', cn: '声学', main: true },
  { x: 742, y: 236, r: 62, seed: 4.7, name: 'HARMONICS', cn: '谐波' },
  { x: 1096, y: 306, r: 118, seed: 8.2, name: 'FOURIER', cn: '傅里叶分析', main: true },
  { x: 1544, y: 402, r: 86, seed: 2.6, name: 'SPECTRUM', cn: '频谱' },
  { x: 592, y: 640, r: 74, seed: 11.4, name: 'MECHANICS', cn: '力学' },
  { x: 902, y: 706, r: 132, seed: 6.1, name: 'TOPOLOGY', cn: '拓扑', main: true },
  { x: 1420, y: 196, r: 54, seed: 3.9, name: 'PHASE', cn: '相位' },
  { x: 1772, y: 520, r: 58, seed: 5.5, name: 'ALGEBRA', cn: '代数' },
  { x: 246, y: 720, r: 58, seed: 9.8, name: 'OPTICS', cn: '光学' },
  { x: 1238, y: 556, r: 42, seed: 7.3, name: 'SIGNAL', cn: '信号' },
];

const MINOR = Array.from({ length: 34 }, (_, i) => ({
  x: 120 + hash(i * 3.7) * 1680,
  y: 120 + hash(i * 8.3) * 720,
  r: 8 + hash(i * 5.1) * 20,
  seed: i * 2.1,
}));

const islandD = (isle: Isle) => smoothClosed(blobPoints(isle.x, isle.y, isle.r, isle.seed, 46, 0.32));

export const Land: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = f - 1380;

  const open = $out(f, 1380, 1460);
  const drift = $out(f, 1380, 1860, 0, 1);
  const cam = 1.12 - open * 0.10 + drift * 0.06;
  const exit = $out(f, 1800, 1860);

  // --- Φ agent path (pure function of frame so the trail is deterministic too)
  const cartAAt = (fr: number) => {
    const d = $out(fr, 1600, 1692, 0, 1);
    return { x: lerp(1096, 1288, d), y: lerp(792, 764, d) };
  };
  const phiAt = (fr: number) => {
    if (fr < 1548) return { x: 1820, y: 980 };
    const ca = cartAAt(fr);
    if (fr < 1600) {
      const e = $out(fr, 1548, 1600, 0, 1);
      return { x: lerp(1820, ca.x + 40, e), y: lerp(980, ca.y + 30, e) };
    }
    if (fr < 1700) return { x: ca.x + 40, y: ca.y + 30 };
    const e = $out(fr, 1706, 1770, 0, 1);
    return { x: lerp(1288 + 40, 1812, e), y: lerp(764 + 30, 960, e) };
  };
  const cartA = cartAAt(f);
  const cartB = { x: 1706, y: 806 };
  const phiPos = phiAt(f);
  const linkDraw = $out(f, 1622, 1690) * 0.62;

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `scale(${cam}) translate(${drift * -10}px, ${drift * 8}px)`,
          opacity: open,
        }}
      >
        {/* ocean glow */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(58% 48% at 50% 44%, rgba(10,40,54,0.85), rgba(3,10,16,0.9) 58%, rgba(1,3,6,1) 100%)',
          }}
        />
        {/* bathymetry */}
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <ellipse
              key={i}
              cx={960}
              cy={520}
              rx={280 + i * 165 + Math.sin(f / 40 + i) * 8}
              ry={180 + i * 110 + Math.cos(f / 46 + i) * 6}
              fill="none"
              stroke={C.cyan}
              strokeWidth={0.6}
              strokeDasharray="2 10"
              opacity={0.06 * open * (1 - i * 0.1)}
            />
          ))}
        </svg>

        {/* sea routes */}
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          {ISLES.slice(0, 8).map((a, i) => {
            const b = ISLES[(i + 3) % ISLES.length];
            const d = `M${a.x} ${a.y} Q${(a.x + b.x) / 2 + 90} ${(a.y + b.y) / 2 - 80} ${b.x} ${b.y}`;
            const p = $out(f, 1400 + i * 9, 1460 + i * 9);
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={C.cyan}
                strokeWidth={0.8}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - p}
                opacity={0.16 * p}
              />
            );
          })}
        </svg>

        {/* islands */}
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          <defs>
            <radialGradient id="landfill" cx="45%" cy="38%" r="70%">
              <stop offset="0%" stopColor="#12394a" stopOpacity="0.95" />
              <stop offset="62%" stopColor="#0a2230" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#05121c" stopOpacity="0.98" />
            </radialGradient>
            <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="0.7" fill={C.cyan} opacity="0.5" />
            </pattern>
          </defs>
          {MINOR.map((m, i) => {
            const p = $out(f, 1392 + hash(i) * 60, 1430 + hash(i) * 60);
            const d = smoothClosed(blobPoints(m.x, m.y, m.r, m.seed, 20, 0.4));
            return <path key={i} d={d} fill="#0a1c26" stroke={C.cyan} strokeWidth={0.8} opacity={0.35 * p} />;
          })}
          {ISLES.map((isle, i) => {
            const p = $out(f, 1388 + i * 14, 1446 + i * 14);
            const d = islandD(isle);
            const sc = 0.82 + 0.18 * p;
            return (
              <g key={i} transform={`translate(${isle.x} ${isle.y}) scale(${sc}) translate(${-isle.x} ${-isle.y})`} opacity={p}>
                <path d={d} fill="none" stroke={C.cyan} strokeWidth={26} opacity={0.05} />
                <path d={d} fill="url(#landfill)" />
                <path d={d} fill="url(#dots)" opacity={0.5} />
                <path d={d} fill="none" stroke={C.cyan} strokeWidth={2.2} opacity={0.28} />
                <path d={d} fill="none" stroke={C.cyanSoft} strokeWidth={0.9} opacity={0.85} />
                <path
                  d={smoothClosed(blobPoints(isle.x, isle.y + 4, isle.r * 0.55, isle.seed * 1.7, 40, 0.38))}
                  fill="none"
                  stroke={C.cyan}
                  strokeWidth={0.6}
                  strokeDasharray="5 7"
                  opacity={0.22}
                />
                {/* cities */}
                {Array.from({ length: 4 }, (_, k) => {
                  const a = hash(i * 5.5 + k * 2.3) * Math.PI * 2;
                  const rr = isle.r * (0.2 + hash(i * 3.1 + k) * 0.65);
                  const cx = isle.x + Math.cos(a) * rr * 1.2;
                  const cy = isle.y + Math.sin(a) * rr * 0.7;
                  const tw = 0.5 + 0.5 * Math.abs(Math.sin(f * 0.05 + k + i));
                  return (
                    <g key={k}>
                      <circle cx={cx} cy={cy} r={9 + tw * 4} fill={C.cyan} opacity={0.06} />
                      <circle cx={cx} cy={cy} r={1.8} fill={C.cyanSoft} opacity={0.55 + tw * 0.4} />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {/* island labels */}
        {ISLES.map((isle, i) => {
          const p = $out(f, 1420 + i * 14, 1470 + i * 14);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: isle.x - 90,
                top: isle.y + isle.r * 0.95 + 22,
                width: 180,
                textAlign: 'center',
                opacity: p * (isle.main ? 0.85 : 0.55),
              }}
            >
              <div style={{ fontFamily: F.mono, fontSize: isle.main ? 11 : 9, letterSpacing: 4, color: C.cyan }}>
                {isle.name}
              </div>
              <div
                style={{
                  fontFamily: F.sans,
                  fontSize: isle.main ? 13 : 10,
                  letterSpacing: 3,
                  color: C.ink,
                  opacity: 0.6,
                  marginTop: 4,
                }}
              >
                {isle.cn}
              </div>
            </div>
          );
        })}

        {/* Φ cards */}
        {[
          { x: cartA.x, y: cartA.y, t: '泛音列', s: 'OVERTONE SET', active: 1 },
          { x: cartB.x, y: cartB.y, t: '频谱分解', s: 'SPECTRUM', active: 0 },
        ].map((c, i) => {
          const p = $out(f, 1560 + i * 14, 1606 + i * 14);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: c.x - 70,
                top: c.y - 44,
                width: 140,
                height: 88,
                borderRadius: 8,
                border: `1px solid ${C.amber}${c.active && f > 1690 ? 'cc' : '55'}`,
                background: 'linear-gradient(160deg, rgba(24,18,10,0.92), rgba(8,10,16,0.94))',
                boxShadow: `0 0 ${18 + (c.active ? 10 : 0)}px rgba(255,201,120,0.16)`,
                opacity: p,
                transform: `scale(${0.9 + 0.1 * p})`,
              }}
            >
              <div style={{ padding: '12px 14px' }}>
                <div style={{ fontFamily: F.sans, fontSize: 15, letterSpacing: 2, color: C.amberSoft, opacity: 0.92 }}>
                  {c.t}
                </div>
                <div style={{ fontFamily: F.mono, fontSize: 7.5, letterSpacing: 2.4, color: C.amber, opacity: 0.55, marginTop: 5 }}>
                  {c.s}
                </div>
                <svg width={112} height={26} style={{ marginTop: 8 }}>
                  <path
                    d={Array.from({ length: 60 }, (_, k) => {
                      const tt = k / 59;
                      const yy = Math.sin(tt * Math.PI * (i ? 6 : 2)) * (i ? 5 : 8);
                      return `${k === 0 ? 'M' : 'L'}${(tt * 112).toFixed(1)} ${13 - yy}`;
                    }).join(' ')}
                    fill="none"
                    stroke={C.amber}
                    strokeWidth={1}
                    opacity={0.5}
                  />
                </svg>
              </div>
            </div>
          );
        })}

        {/* partial link */}
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          {linkDraw > 0 &&
            (() => {
              const x1 = cartB.x - 70;
              const y1 = cartB.y;
              const x2 = cartA.x + 70;
              const y2 = cartA.y;
              const ex = lerp(x1, x2, linkDraw / 0.62);
              const ey = lerp(y1, y2, linkDraw / 0.62);
              return (
                <g opacity={$out(f, 1620, 1642)}>
                  <path
                    d={`M${x1} ${y1} L${ex} ${ey}`}
                    stroke={C.amber}
                    strokeWidth={1.4}
                    strokeDasharray="6 5"
                    opacity={0.85}
                  />
                  <circle cx={ex} cy={ey} r={3} fill={C.amber} opacity={0.9} />
                  <circle cx={ex} cy={ey} r={12} fill="none" stroke={C.amber} strokeWidth={0.8} opacity={0.4} />
                </g>
              );
            })()}
        </svg>

        {/* Φ */}
        {f > 1548 && (
          <div
            style={{
              position: 'absolute',
              left: phiPos.x - 30,
              top: phiPos.y - 30,
              width: 60,
              height: 60,
              opacity: $out(f, 1548, 1576),
            }}
          >
            {[1, 2, 3, 4, 5].map((k) => {
              const pt = phiAt(f - k * 2.5);
              return (
                <div
                  key={k}
                  style={{
                    position: 'absolute',
                    left: 30 + (pt.x - phiPos.x),
                    top: 30 + (pt.y - phiPos.y),
                    width: 4,
                    height: 4,
                    marginLeft: -2,
                    marginTop: -2,
                    borderRadius: 4,
                    background: C.amber,
                    opacity: 0.3 - k * 0.045,
                  }}
                />
              );
            })}
            <div
              style={{
                position: 'absolute',
                left: 18,
                top: 18,
                width: 24,
                height: 24,
                borderRadius: 24,
                background: `radial-gradient(circle, ${C.amberSoft} 0%, ${C.amber} 40%, rgba(255,201,120,0) 72%)`,
                boxShadow: `0 0 26px ${C.amber}`,
                opacity: 0.9,
                transform: `scale(${1 + 0.25 * Math.sin(f * 0.5)})`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: -6,
                top: -22,
                fontFamily: F.mono,
                fontSize: 9,
                letterSpacing: 3,
                color: C.amber,
                opacity: 0.7,
              }}
            >
              Φ
            </div>
          </div>
        )}

        {/* connect stop label */}
        <div
          style={{
            position: 'absolute',
            left: 1430,
            top: 700,
            fontFamily: F.mono,
            fontSize: 9,
            letterSpacing: 3,
            color: C.amber,
            opacity: $out(f, 1680, 1712) * 0.8,
          }}
        >
          LINK 62% — HELD
        </div>

        {/* top readout */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 128,
            textAlign: 'center',
            fontFamily: F.mono,
            fontSize: 9,
            letterSpacing: 7,
            color: C.cyanDim,
            opacity: $out(f, 1400, 1440) * 0.7,
          }}
        >
          CARTOGRAPHY · LAYER 04 · {ISLES.length + MINOR.length} LANDMASSES
        </div>
      </AbsoluteFill>

      {/* entry flash */}
      <AbsoluteFill style={{ background: C.cyan, opacity: decay(f, 1380, 4) * 0.35, mixBlendMode: 'screen' }} />
      {/* exit zoom */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 48% 46%, transparent 0%, rgba(0,2,6,${0.85 * exit}) 60%)`,
        }}
      />
      {fps && null}
    </AbsoluteFill>
  );
};
