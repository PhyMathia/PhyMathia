import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';
import { $out, decay, hash, polyline } from '../lib';
import { Card, Chip } from '../components/ui';

const sumCurve = (w: number, amp: number, samples = 260) => {
  const pts: [number, number][] = [];
  let norm = 0;
  for (let n = 1; n <= 8; n++) norm += 1 / n;
  for (let s = 0; s <= samples; s++) {
    const t = s / samples;
    let y = 0;
    for (let n = 1; n <= 8; n++) y += (1 / n) * Math.sin(n * Math.PI * t);
    pts.push([t * w, -(y / norm) * amp]);
  }
  return polyline(pts);
};

export const Back: React.FC = () => {
  const f = useCurrentFrame();
  const jump = $out(f, 1860, 1900, 0, 1);
  const land = $out(f, 1892, 1932);
  const beat = Math.max(decay(f, 2060, 7), decay(f, 2092, 7), decay(f, 2124, 7));
  const push = $out(f, 2040, 2220, 0, 1);
  const out = $out(f, 2170, 2220);

  return (
    <AbsoluteFill>
      {/* hyperspace streaks */}
      {f < 1912 && (
        <AbsoluteFill>
          <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
            {Array.from({ length: 70 }, (_, i) => {
              const a = hash(i * 2.7) * Math.PI * 2;
              const r0 = 60 + hash(i * 5.9) * 260;
              const len = 300 + jump * 1500 * (0.4 + hash(i * 1.3));
              return (
                <line
                  key={i}
                  x1={960 + Math.cos(a) * r0}
                  y1={540 + Math.sin(a) * r0 * 0.8}
                  x2={960 + Math.cos(a) * (r0 + len)}
                  y2={540 + Math.sin(a) * (r0 + len) * 0.8}
                  stroke={i % 9 === 0 ? C.amber : C.cyan}
                  strokeWidth={0.8 + hash(i) * 1.6}
                  opacity={0.35 * (1 - land * 0.8)}
                />
              );
            })}
          </svg>
        </AbsoluteFill>
      )}

      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${(1.35 - land * 0.35) * (1 + beat * 0.012) * (1 + push * 0.18)})`,
          opacity: land * (1 - out * 0.55),
        }}
      >
        <div style={{ position: 'relative', boxShadow: `0 0 ${60 + beat * 60}px rgba(79,227,255,${0.1 + beat * 0.12})` }}>
          <Card w={1000} h={424} title="NODE 0001 / RETRIEVED" active={0.8 + beat}>
            <div
              style={{
                position: 'absolute',
                right: 22,
                top: 14,
                fontFamily: F.mono,
                fontSize: 10,
                letterSpacing: 3,
                color: C.amber,
                opacity: 0.8,
              }}
            >
              CACHE HIT · 0.42 s
            </div>

            <div style={{ padding: '12px 34px 0' }}>
              <div
                style={{
                  fontFamily: F.sans,
                  fontSize: 32,
                  letterSpacing: 2,
                  lineHeight: 1.3,
                  color: C.ink,
                  opacity: 0.95,
                }}
              >
                为什么一个音，听起来是一个音？
              </div>
              <div
                style={{
                  marginTop: 14,
                  height: 1,
                  background: `linear-gradient(to right, ${C.cyan}55, ${C.cyan}0d)`,
                }}
              />
            </div>

            <div style={{ display: 'flex', padding: '12px 34px 0', gap: 24 }}>
              <div style={{ width: 446 }}>
                <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 4, color: C.cyan, opacity: 0.6 }}>
                  PHYSICS — 物理直觉
                </div>
                <svg width={446} height={132} style={{ marginTop: 10, overflow: 'visible' }}>
                  <line x1={0} x2={446} y1={66} y2={66} stroke={C.cyan} strokeWidth={0.5} opacity={0.14} />
                  <g transform="translate(0,66)">
                    <path d={sumCurve(446, 48)} fill="none" stroke={C.cyan} strokeWidth={2.2} opacity={0.95} />
                    <path d={sumCurve(446, 48)} fill="none" stroke={C.cyanSoft} strokeWidth={12} opacity={0.07} />
                  </g>
                </svg>
                <div style={{ fontFamily: F.mono, fontSize: 8, letterSpacing: 3, color: C.slate, opacity: 0.5, marginTop: 2 }}>
                  Σ aₙ sin(nπx/L) — 8 MODES
                </div>
              </div>

              <div style={{ width: 1, background: `linear-gradient(to bottom, transparent, ${C.cyan}44, transparent)` }} />

              <div style={{ width: 440 }}>
                <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 4, color: C.cyan, opacity: 0.6 }}>
                  MATH — 数学结构
                </div>
                <svg width={440} height={132} style={{ marginTop: 10 }}>
                  {Array.from({ length: 8 }, (_, i) => {
                    const n = i + 1;
                    const h = (1 / n) * 92;
                    return (
                      <g key={i}>
                        <rect
                          x={i * 54 + 6}
                          y={112 - h}
                          width={42}
                          height={h}
                          fill={C.cyan}
                          opacity={0.1 + 0.55 / n}
                          stroke={C.cyan}
                          strokeWidth={0.6}
                        />
                        <text x={i * 54 + 27} y={128} fill={C.cyan} fontSize={8} fontFamily={F.mono} textAnchor="middle" opacity={0.5}>
                          {n}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, padding: '8px 34px 0' }}>
              {['双域解释', '同一组数字', '可追问', '可生长'].map((c) => (
                <Chip key={c} label={c} />
              ))}
            </div>

            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 46,
                borderTop: `1px solid ${C.cyan}22`,
                background: 'rgba(79,227,255,0.03)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 34px',
                fontFamily: F.mono,
                fontSize: 9,
                letterSpacing: 3,
                color: C.cyan,
                opacity: 0.65,
              }}
            >
              <span>PHYSICS ≡ MATH · ONE STRUCTURE</span>
              <span style={{ color: C.amber }}>LOCKED · 8 MODES · aₙ = 1/n</span>
            </div>
          </Card>

          <svg width={1000} height={424} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
            {[
              [0, 0, 1, 1],
              [1000, 0, -1, 1],
              [0, 424, 1, -1],
              [1000, 424, -1, -1],
            ].map(([x, y, sx, sy], i) => (
              <path
                key={i}
                d={`M${x + 22 * sx} ${y} L${x} ${y} L${x} ${y + 22 * sy}`}
                stroke={C.cyan}
                strokeWidth={1.4}
                fill="none"
                opacity={0.6}
              />
            ))}
          </svg>
        </div>
      </AbsoluteFill>

      {[0, 1, 2].map((i) => {
        const p = $out(f, 1952 + i * 18, 2070 + i * 18, 0, 1);
        const r = 300 + p * 660;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: r * 2,
              height: r * 2,
              marginLeft: -r,
              marginTop: -r,
              borderRadius: '50%',
              border: `1px solid ${C.cyan}`,
              opacity: (1 - p) * 0.2,
            }}
          />
        );
      })}

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 168,
          textAlign: 'center',
          fontFamily: F.mono,
          fontSize: 10,
          letterSpacing: 9,
          color: C.cyan,
          opacity: $out(f, 1980, 2020) * (1 - out) * 0.62,
        }}
      >
        ANSWER PERSISTS
      </div>

      <AbsoluteFill style={{ background: '#000205', opacity: out }} />
      <AbsoluteFill
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 540,
          height: 1,
          background: `linear-gradient(to right, transparent, ${C.cyan}, transparent)`,
          opacity: out * 0.8,
        }}
      />
    </AbsoluteFill>
  );
};
