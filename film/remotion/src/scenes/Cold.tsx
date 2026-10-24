import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from '../theme';
import { $, $exp, $out, decay, decrypt, hash } from '../lib';

const RAW = 'det A = ad − bc';
// italic only the matrix entries and A (positions in RAW), never the "det" operator
const ITALIC = new Set([4, 8, 9, 13, 14]);
const BRIGHT = new Set([8, 9, 13, 14]);

const FRAGS = [
  { t: 'SIG 0x2F / ACQUIRED', x: 1420, y: 250, s: 0.35 },
  { t: 'TRACE 04:11:00', x: 210, y: 690, s: 1.0 },
  { t: 'Δ LOCK 0.0081', x: 1500, y: 760, s: 0.62 },
  { t: 'DETERMINANT / 2×2', x: 236, y: 232, s: 0.18 },
  { t: 'SRC  TEXTBOOK p.113', x: 1470, y: 712, s: 0.82 },
];

export const Cold: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  const born = $out(f, 2, 26);
  const hair = $exp(f, 18, 44);
  const hit = decay(f, 0, 10) * 0.03 + decay(f, 250, 8) * 0.02;
  const cam = 1 + born * 0.02 + hit;
  const lockT = (i: number) => 52 + i * 4;
  const underline = $out(f, 118, 148);
  const bracketP = $out(f, 116, 142);
  const scanX = $out(f, 158, 208, 0, 1.15);
  const shatter = (i: number) => $out(f, 246 + i * 1.2, 278 + i * 1.2, 0, 1);

  return (
    <AbsoluteFill style={{ transform: `scale(${cam})` }}>
      {/* rotating reticle */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 660,
          height: 660,
          marginLeft: -330,
          marginTop: -330,
          opacity: $out(f, 10, 40) * 0.16,
          transform: `rotate(${f * 0.25}deg)`,
        }}
      >
        <svg width={660} height={660}>
          <circle cx={330} cy={330} r={300} fill="none" stroke={C.cyan} strokeWidth={1} strokeDasharray="2 14" />
          <circle cx={330} cy={330} r={250} fill="none" stroke={C.cyan} strokeWidth={1} strokeDasharray="90 600" opacity={0.7} />
        </svg>
      </div>

      {/* hairline */}
      <div
        style={{
          position: 'absolute',
          left: 960 - 960 * hair,
          top: 541,
          width: 1920 * hair,
          height: 1,
          background: `linear-gradient(to right, transparent, ${C.cyan} 18%, ${C.cyanSoft} 50%, ${C.cyan} 82%, transparent)`,
          boxShadow: `0 0 16px ${C.cyan}`,
          opacity: 0.55 + 0.45 * Math.abs(Math.sin(f * 1.7)),
        }}
      />

      {/* fragments */}
      {FRAGS.map((fr, i) => {
        const on = f > 30 + i * 16 && hash(i + Math.floor(f / 6)) > 0.12;
        const o = $out(f, 30 + i * 16, 44 + i * 16) * (on ? 0.55 : 0.18);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: fr.x,
              top: fr.y,
              fontFamily: F.mono,
              fontSize: 11,
              letterSpacing: 3,
              color: C.cyan,
              opacity: o * 0.9,
            }}
          >
            <span style={{ opacity: 0.4 }}>{String(i + 1).padStart(2, '0')} </span>
            {fr.t}
          </div>
        );
      })}

      {/* the formula */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 468,
          display: 'flex',
          justifyContent: 'flex-start',
          paddingLeft: 458,
          fontFamily: F.serif,
          fontSize: 112,
          letterSpacing: 2,
          color: C.ink,
        }}
      >
        {RAW.split('').map((ch, i) => {
          const locked = f >= lockT(i);
          const sh = shatter(i);
          const flash = decay(f, lockT(i), 4);
          return (
            <span
              key={i}
              style={{
                whiteSpace: 'pre',
                fontStyle: ITALIC.has(i) ? 'italic' : 'normal',
                display: 'inline-block',
                opacity: (locked ? 1 : 0.55) * (1 - sh) * born,
                color: flash > 0.15 ? '#FFFFFF' : BRIGHT.has(i) ? C.cyanSoft : C.ink,
                textShadow:
                  flash > 0.02
                    ? `0 0 ${8 + flash * 44}px rgba(79,227,255,${0.5 + flash}), 0 0 90px rgba(79,227,255,${flash * 0.6})`
                    : '0 0 26px rgba(120,220,255,0.30)',
                transform: `translate(${(hash(i * 3.1) - 0.5) * 900 * sh}px, ${-700 * sh * (0.3 + hash(i * 7.3))}px) rotate(${(hash(i * 2.2) - 0.5) * 80 * sh}deg) scale(${1 + flash * 0.06 - sh * 0.4})`,
                filter: sh > 0.02 ? `blur(${sh * 10}px)` : undefined,
              }}
            >
              {decrypt(f, 52 + i * 4, ch, 4, i)}
            </span>
          );
        })}
      </div>

      {/* underline + target */}
      <div
        style={{
          position: 'absolute',
          left: 960 - 300 * underline,
          top: 604,
          width: 600 * underline,
          height: 1,
          background: `linear-gradient(to right, transparent, ${C.cyan}, transparent)`,
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 640,
          textAlign: 'center',
          fontFamily: F.mono,
          fontSize: 10,
          letterSpacing: 6,
          color: C.cyanDim,
          opacity: $out(f, 132, 156) * 0.9,
        }}
      >
        TARGET — DETERMINANT · 2×2 · SINGLE SCALAR
      </div>

      {/* scan band */}
      {f > 156 && f < 212 && (
        <div
          style={{
            position: 'absolute',
            left: 240 + scanX * 1440,
            top: 420,
            width: 2,
            height: 240,
            background: `linear-gradient(to bottom, transparent, ${C.cyan}, transparent)`,
            boxShadow: `0 0 30px ${C.cyan}`,
            opacity: 0.8,
          }}
        />
      )}

      {/* brackets on the whole line */}
      <div style={{ position: 'absolute', left: 500, top: 440, width: 920, height: 200, opacity: bracketP }}>
        <svg width={920} height={200} style={{ overflow: 'visible' }}>
          {[
            [0, 0, 1, 1],
            [920, 0, -1, 1],
            [0, 200, 1, -1],
            [920, 200, -1, -1],
          ].map(([x, y, sx, sy], i) => {
            const off = (1 - bracketP) * 70;
            return (
              <path
                key={i}
                d={`M${x + off * sx} ${y} L${x} ${y} L${x} ${y + off * sy}`}
                stroke={C.cyan}
                strokeWidth={1.2}
                fill="none"
                opacity={0.7}
              />
            );
          })}
        </svg>
      </div>

      {/* expanding ring after the shatter */}
      {[0, 1, 2].map((i) => {
        const t = $out(f, 258 + i * 12, 300 + i * 12, 0, 1);
        const r = 80 + t * 620;
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
              opacity: (1 - t) * 0.35,
            }}
          />
        );
      })}

      {/* faint warm rim at the very start */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(50% 40% at 50% 50%, rgba(255,201,120,${0.06 * (1 - $out(f, 0, 40))}), transparent 70%)`,
        }}
      />
    </AbsoluteFill>
  );
};
