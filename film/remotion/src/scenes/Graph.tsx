import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from '../theme';
import { $, $out, decay, hash, spr } from '../lib';
import { Card, Chip } from '../components/ui';

type N = { x: number; y: number; t: string; s: string; w?: number };
const NODES: N[] = [
  { x: 292, y: 322, t: '驻波', s: 'STANDING WAVE' },
  { x: 238, y: 706, t: '基频', s: 'FUNDAMENTAL' },
  { x: 566, y: 188, t: '谐波', s: 'HARMONICS' },
  { x: 600, y: 764, t: '叠加', s: 'SUPERPOSITION', w: 196 },
  { x: 1288, y: 216, t: '傅里叶级数', s: 'FOURIER SERIES', w: 200 },
  { x: 1584, y: 470, t: '频谱', s: 'SPECTRUM' },
  { x: 1330, y: 832, t: '音色', s: 'TIMBRE' },
  { x: 1690, y: 288, t: '相位', s: 'PHASE' },
  { x: 862, y: 830, t: '波腹', s: 'ANTINODE' },
  { x: 1180, y: 762, t: '拍频', s: 'BEATING' },
];

const CX = 960;
const CY = 472;

const ctrl = (x: number, y: number, i: number) => ({
  mx: (CX + x) / 2 + (hash(i * 4.1) - 0.5) * 120,
  my: (CY + y) / 2 + (hash(i * 7.7) - 0.5) * 120,
});

const edge = (x: number, y: number, i: number) => {
  const { mx, my } = ctrl(x, y, i);
  return `M${CX} ${CY} Q${mx} ${my} ${x} ${y}`;
};

const along = (x: number, y: number, i: number, t: number) => {
  const { mx, my } = ctrl(x, y, i);
  const u = 1 - t;
  return {
    x: u * u * CX + 2 * u * t * mx + t * t * x,
    y: u * u * CY + 2 * u * t * my + t * t * y,
  };
};

export const Graph: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = f - 1020;

  const intro = spr(f, 1020, fps, { damping: 15, stiffness: 150 });
  const push = $out(f, 1250, 1380, 0, 1);
  const camScale = (0.94 + intro * 0.06) * (1 - push * 0.42);
  const camRot = -1.4 * $out(f, 1180, 1380);

  const micro = Array.from({ length: 54 }, (_, i) => {
    const a = hash(i * 3.3) * Math.PI * 2;
    const r = 360 + hash(i * 9.1) * 460;
    return { x: CX + Math.cos(a) * r * 1.25, y: CY + Math.sin(a) * r * 0.78, i, r };
  });

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `scale(${camScale}) rotate(${camRot}deg)`,
          transformOrigin: '50% 50%',
        }}
      >
        {/* giant counter */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 430,
            textAlign: 'center',
            fontFamily: F.mono,
            fontSize: 300,
            fontWeight: 700,
            color: C.cyan,
            opacity: 0.055 * $out(f, 1040, 1100),
            letterSpacing: -10,
          }}
        >
          {String(1 + Math.floor($out(f, 1020, 1380) * 1283)).padStart(4, '0')}
        </div>

        {/* edges */}
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          {NODES.map((n, i) => {
            const a = 1044 + i * 11;
            const p = $out(f, a, a + 22);
            return (
              <g key={i}>
                <path
                  d={edge(n.x, n.y, i)}
                  fill="none"
                  stroke={C.cyan}
                  strokeWidth={1.1}
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - p}
                  opacity={0.45 * p}
                />
                <circle
                  cx={along(n.x, n.y, i, (f * 0.012 + i * 0.13) % 1).x}
                  cy={along(n.x, n.y, i, (f * 0.012 + i * 0.13) % 1).y}
                  r={2.6}
                  fill={C.cyanSoft}
                  opacity={p * 0.9}
                />
              </g>
            );
          })}
          {/* micro network */}
          {micro.map((m, i) => {
            const a = 1206 + hash(i * 1.7) * 120;
            const p = $out(f, a, a + 20) * (1 - push * 0.6);
            return (
              <g key={`m${i}`}>
                {i % 3 === 0 && (
                  <line
                    x1={m.x}
                    y1={m.y}
                    x2={CX + (m.x - CX) * 0.72}
                    y2={CY + (m.y - CY) * 0.72}
                    stroke={C.cyan}
                    strokeWidth={0.5}
                    opacity={0.16 * p}
                  />
                )}
                <circle cx={m.x} cy={m.y} r={1.8 + hash(i) * 2} fill={i % 7 === 0 ? C.amber : C.cyan} opacity={0.55 * p} />
              </g>
            );
          })}
        </svg>

        {/* neighbour cards */}
        {NODES.map((n, i) => {
          const a = 1044 + i * 11;
          const p = spr(f, a, fps, { damping: 14, stiffness: 210, mass: 0.45 });
          const w = n.w ?? 172;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: n.x - w / 2,
                top: n.y - 31,
                width: w,
                height: 62,
                transform: `scale(${0.7 + p * 0.3})`,
                opacity: Math.min(1, p * 1.4),
              }}
            >
              <Card w={w} h={62} active={f < a + 24 ? 1 : 0}>
                <div style={{ padding: '11px 14px 0' }}>
                  <div
                    style={{
                      fontFamily: F.sans,
                      fontSize: 17,
                      fontWeight: 500,
                      letterSpacing: 2,
                      color: C.ink,
                      opacity: 0.92,
                    }}
                  >
                    {n.t}
                  </div>
                  <div
                    style={{
                      fontFamily: F.mono,
                      fontSize: 7.5,
                      letterSpacing: 2.4,
                      color: C.cyan,
                      opacity: 0.5,
                      marginTop: 6,
                    }}
                  >
                    {n.s}
                  </div>
                </div>
              </Card>
            </div>
          );
        })}

        {/* hero card */}
        <div
          style={{
            position: 'absolute',
            left: CX - 250,
            top: CY - 141,
            transform: `scale(${0.86 + intro * 0.14})`,
            opacity: Math.min(1, intro * 2),
            boxShadow: `0 0 90px rgba(79,227,255,${0.12 + decay(f, 1200, 12) * 0.3})`,
          }}
        >
          <Card w={500} h={282} title="NODE 0001 — DUAL DOMAIN" active={0.7}>
            <div style={{ padding: '12px 20px 0' }}>
              <div
                style={{
                  fontFamily: F.sans,
                  fontSize: 23,
                  lineHeight: 1.45,
                  letterSpacing: 1.5,
                  color: C.ink,
                  opacity: 0.94,
                }}
              >
                为什么一个音，
                <br />
                听起来是一个音？
              </div>
              <svg width={460} height={62} style={{ marginTop: 10, overflow: 'visible' }}>
                <line x1={0} x2={460} y1={31} y2={31} stroke={C.cyan} strokeWidth={0.5} opacity={0.2} />
                <path
                  d={Array.from({ length: 200 }, (_, i) => {
                    const t = i / 199;
                    const y =
                      Math.sin(t * Math.PI * 2) * 0.6 +
                      Math.sin(t * Math.PI * 6) * 0.24 +
                      Math.sin(t * Math.PI * 10) * 0.12;
                    return `${i === 0 ? 'M' : 'L'}${(t * 460).toFixed(1)} ${(31 - y * 24).toFixed(1)}`;
                  }).join(' ')}
                  fill="none"
                  stroke={C.cyan}
                  strokeWidth={1.6}
                  opacity={0.85}
                />
              </svg>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                {['声学', '傅里叶', '叠加原理'].map((c) => (
                  <Chip key={c} label={c} />
                ))}
              </div>
            </div>
          </Card>
        </div>

        {/* readout */}
        <div
          style={{
            position: 'absolute',
            left: 1330,
            top: 930,
            fontFamily: F.mono,
            fontSize: 9,
            letterSpacing: 4,
            color: C.cyanDim,
            opacity: $out(f, 1100, 1140) * 0.8,
          }}
        >
          EXPANDING NEIGHBOURHOOD / DEPTH 2 / {Math.floor(4 + t0 * 0.22)} LINKED
        </div>
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 46%, transparent 20%, rgba(0,2,6,${0.55 * push}) 78%)`,
        }}
      />
    </AbsoluteFill>
  );
};
