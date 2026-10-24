import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';
import { $out, decay, polyline, wavePoints } from '../lib';

const ROWS = 8;
const ROW0 = 272;
const ROWGAP = 44;
const MODES = [1, 2, 3, 4, 5, 6, 7, 8];
const SUB = ['₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈'];
const CW = 680;
const CY = 762;
const AMP = 82;

const cw = (n: number) => 1 / n;

const sumPath = (k: number, ramps: number[], w: number, amp: number, samples = 320) => {
  const pts: [number, number][] = [];
  let norm = 0;
  for (let i = 1; i <= k; i++) norm += cw(i) * (ramps[i] ?? 1);
  if (norm <= 0) norm = 1;
  for (let s = 0; s <= samples; s++) {
    const t = s / samples;
    let y = 0;
    for (let i = 1; i <= k; i++) y += Math.sin(i * Math.PI * t) * cw(i) * (ramps[i] ?? 1);
    pts.push([t * w, -((y / norm) * amp)]);
  }
  return polyline(pts);
};

const Curve: React.FC<{ d: string; w: number; color: string; mirror?: boolean; dash?: number }> = ({
  d,
  w,
  color,
  mirror = true,
  dash,
}) => (
  <svg width={w} height={220} style={{ overflow: 'visible' }}>
    <line x1={0} x2={w} y1={110} y2={110} stroke={C.cyan} strokeWidth={0.5} opacity={0.18} strokeDasharray="4 8" />
    {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
      <line
        key={i}
        x1={t * w}
        x2={t * w}
        y1={105}
        y2={115}
        stroke={C.cyan}
        strokeWidth={0.6}
        opacity={0.26}
      />
    ))}
    <g transform="translate(0,110)">
      {mirror && <path d={d} fill="none" stroke={color} strokeWidth={1} opacity={0.14} transform="scale(1,-1)" />}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2.4}
        pathLength={1}
        strokeDasharray={dash ?? undefined}
        strokeDashoffset={dash !== undefined ? 1 - dash : undefined}
      />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={10}
        opacity={0.08}
        pathLength={1}
        strokeDasharray={dash ?? undefined}
        strokeDashoffset={dash !== undefined ? 1 - dash : undefined}
      />
    </g>
    <circle cx={0} cy={110} r={3.5} fill={color} opacity={0.9} />
    <circle cx={w} cy={110} r={3.5} fill={color} opacity={0.9} />
  </svg>
);

export const Dual: React.FC = () => {
  const f = useCurrentFrame();

  const appear = (n: number) => 600 + (n - 1) * 30;
  const ramps: number[] = [];
  for (let n = 1; n <= ROWS; n++) ramps[n] = $out(f, appear(n), appear(n) + 16, 0, 1);

  const k = Math.max(1, Math.min(ROWS, Math.floor((f - 600) / 30) + 1));
  const lock = $out(f, 840, 900);
  const t0 = f - 540;
  const collapse = $out(f, 962, 1020, 0, 1);
  const exitFlash = decay(f, 1016, 3);

  const eqA = $out(f, 900, 930);
  const eqB = $out(f, 918, 948);

  const sum = sumPath(k, ramps, CW, AMP);
  const draw = $out(f, 840, 890);

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${1 - collapse * 0.55})`, opacity: 1 - collapse * 0.92 }}>
        {/* divider */}
        <div
          style={{
            position: 'absolute',
            left: 959,
            top: 130,
            width: 1,
            height: 720 * $out(f, t0, t0 + 20),
            background: `linear-gradient(to bottom, transparent, ${C.cyan}${lock > 0.4 ? 'cc' : '44'}, transparent)`,
            boxShadow: lock > 0.3 ? `0 0 22px ${C.cyan}` : 'none',
          }}
        />

        {/* headers */}
        {[
          { x: 150, t: '01 / PHYSICS', cn: '物理直觉' },
          { x: 1090, t: '02 / MATHEMATICS', cn: '数学结构' },
        ].map((h, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: h.x,
              top: 152,
              display: 'flex',
              alignItems: 'baseline',
              gap: 18,
              opacity: $out(f, t0 + i * 4, t0 + 26),
            }}
          >
            <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 6, color: C.cyan, opacity: 0.85 }}>{h.t}</div>
            <div style={{ fontFamily: F.sans, fontSize: 17, letterSpacing: 4, color: C.ink, opacity: 0.55 }}>{h.cn}</div>
          </div>
        ))}
        <div
          style={{
            position: 'absolute',
            left: 150,
            top: 178,
            width: 1620,
            height: 1,
            background: `linear-gradient(to right, ${C.cyan}55, ${C.cyan}0d 30%, transparent 50%, ${C.cyan}0d 70%, ${C.cyan}55)`,
            opacity: $out(f, t0, t0 + 24) * 0.55,
          }}
        />

        {/* left: mode stack */}
        {MODES.map((n) => {
          const a = appear(n);
          const p = $out(f, a, a + 16);
          const y = ROW0 + (n - 1) * ROWGAP;
          const hot = decay(f, a + 4, 6);
          return (
            <div key={n} style={{ position: 'absolute', left: 150, top: y - 22, opacity: p, transform: `translateX(${(1 - p) * -36}px)` }}>
              <div
                style={{
                  fontFamily: F.mono,
                  fontSize: 11,
                  letterSpacing: 3,
                  color: hot > 0.15 ? C.ink : C.cyan,
                  position: 'absolute',
                  left: 0,
                  top: 17,
                  opacity: 0.9,
                }}
              >
                n={n}
              </div>
              <svg width={CW + 40} height={44} style={{ position: 'absolute', left: 62, top: 0, overflow: 'visible' }}>
                <line x1={0} x2={CW} y1={22} y2={22} stroke={C.cyan} strokeWidth={0.5} opacity={0.1} />
                <path
                  d={polyline(wavePoints(n, 14, CW, 44, 300))}
                  fill="none"
                  stroke={hot > 0.1 ? C.ink : C.cyan}
                  strokeWidth={1.3}
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - p}
                  opacity={0.55 + hot * 0.4}
                />
              </svg>
              <div
                style={{
                  position: 'absolute',
                  left: CW + 36,
                  top: 15,
                  fontFamily: F.mono,
                  fontSize: 9,
                  letterSpacing: 2,
                  color: C.slate,
                  opacity: 0.55,
                }}
              >
                f₁×{n}
              </div>
            </div>
          );
        })}

        {/* right: amplitude ladder */}
        {MODES.map((n) => {
          const a = appear(n);
          const p = $out(f, a, a + 16);
          const y = ROW0 + (n - 1) * ROWGAP;
          const w = cw(n) * 330;
          const hot = decay(f, a + 4, 6);
          return (
            <div key={n} style={{ position: 'absolute', left: 1090, top: y - 12, opacity: p }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div
                  style={{
                    width: w * p,
                    height: 16,
                    background: `linear-gradient(to right, ${hot > 0.1 ? C.ink : C.cyan}cc, ${C.cyan}22)`,
                    boxShadow: `0 0 ${8 + hot * 24}px ${C.cyan}44`,
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  <svg width={Math.max(1, w * p)} height={16} style={{ position: 'absolute', left: 0, top: 0 }}>
                    <path
                      d={polyline(wavePoints(n, 5, Math.max(1, w * p), 16, 160))}
                      fill="none"
                      stroke={C.ink}
                      strokeWidth={0.7}
                      opacity={0.28}
                    />
                  </svg>
                </div>
                <div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 2, color: C.ink, opacity: 0.5 }}>
                  a{SUB[n - 1]} = {cw(n).toFixed(2)}
                </div>
              </div>
            </div>
          );
        })}

        {/* reveal beams */}
        {MODES.map((n) => {
          const a = appear(n);
          const g = decay(f, a + 6, 7);
          if (g <= 0.02) return null;
          const y = ROW0 + (n - 1) * ROWGAP;
          return (
            <div
              key={n}
              style={{
                position: 'absolute',
                left: 890,
                top: y,
                width: 170,
                height: 1,
                background: `linear-gradient(to right, transparent, ${C.cyan}, ${C.amber})`,
                opacity: g * 0.9,
                boxShadow: `0 0 14px ${C.cyan}`,
              }}
            />
          );
        })}

        {/* composite curves */}
        <div style={{ position: 'absolute', left: 150, top: CY - 110, opacity: $out(f, 604, 632) }}>
          <div style={{ position: 'absolute', left: -34, top: 108, fontFamily: F.mono, fontSize: 9, color: C.cyan, opacity: 0.4 }}>
            y
          </div>
          <Curve d={sum} w={CW} color={C.cyan} />
        </div>
        <div style={{ position: 'absolute', left: 1090, top: CY - 110, opacity: $out(f, 838, 872) }}>
          <div style={{ position: 'absolute', left: -34, top: 108, fontFamily: F.mono, fontSize: 9, color: C.cyan, opacity: 0.4 }}>
            y
          </div>
          <Curve d={sum} w={CW} color={C.ink} dash={draw} />
        </div>
        <div
          style={{
            position: 'absolute',
            left: 150,
            top: CY + 44,
            fontFamily: F.mono,
            fontSize: 8,
            letterSpacing: 3,
            color: C.slate,
            opacity: 0.45,
          }}
        >
          x →  L
        </div>
        <div
          style={{
            position: 'absolute',
            left: 1090,
            top: CY + 44,
            fontFamily: F.mono,
            fontSize: 8,
            letterSpacing: 3,
            color: C.slate,
            opacity: 0.45,
          }}
        >
          x →  L
        </div>

        {/* lock */}
        <div
          style={{
            position: 'absolute',
            left: 830,
            width: 260,
            top: CY - 100,
            textAlign: 'center',
            opacity: $out(f, 860, 890),
            transform: `scale(${0.8 + 0.2 * $out(f, 860, 890)})`,
          }}
        >
          <div style={{ fontFamily: F.serif, fontSize: 92, color: C.cyan, lineHeight: 1, textShadow: `0 0 40px ${C.cyan}` }}>≡</div>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 9,
              letterSpacing: 4,
              color: C.amber,
              opacity: $out(f, 880, 905) * 0.9,
              marginTop: 16,
              whiteSpace: 'nowrap',
            }}
          >
            IDENTICAL
          </div>
        </div>

        {/* equations */}
        <div
          style={{
            position: 'absolute',
            left: 150,
            top: 614,
            width: 700,
            fontFamily: F.serif,
            fontSize: 27,
            color: C.ink,
            opacity: eqA * 0.9,
            letterSpacing: 1,
            fontStyle: 'italic',
          }}
        >
          y(x) = Σ aₙ · sin(nπx / L)
        </div>
        <div
          style={{
            position: 'absolute',
            left: 1090,
            top: 614,
            width: 760,
            fontFamily: F.serif,
            fontSize: 27,
            color: C.ink,
            opacity: eqB * 0.9,
            letterSpacing: 1,
            fontStyle: 'italic',
          }}
        >
          aₙ = 1/n &nbsp;&nbsp;·&nbsp;&nbsp; ωₙ = n·ω₁
        </div>

        {/* lock flash */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: CY,
            height: 1,
            background: `linear-gradient(to right, transparent, ${C.cyan}, transparent)`,
            opacity: decay(f, 884, 8) * 0.9,
            boxShadow: `0 0 40px ${C.cyan}`,
          }}
        />
      </AbsoluteFill>

      <AbsoluteFill style={{ background: C.cyan, opacity: exitFlash * 0.5, mixBlendMode: 'screen' }} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,${0.55 * $out(f, 980, 1020)}) 80%)`,
        }}
      />
    </AbsoluteFill>
  );
};
