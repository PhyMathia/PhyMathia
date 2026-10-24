import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';
import { $out, decay, hash, typed } from '../lib';

const Q = '为什么一个音，听起来是一个音？';
const CHW = 74;
const QL = 960 - (Q.length * CHW) / 2;

const LOG = [
  ['00.001', 'core.boot()', 'OK'],
  ['00.014', 'canvas.render', 'ONLINE'],
  ['00.031', 'dual.domain', 'LINKED'],
  ['00.047', 'memory.bank', '1284'],
  ['00.062', 'agent.Φ', 'IDLE'],
  ['00.073', 'trust.handoff', 'TRUE'],
];

export const Boot: React.FC = () => {
  const f = useCurrentFrame();
  const typeStart = 366;
  const typedStr = typed(f, typeStart, Q, 4);
  const done = typedStr.length;
  const caretX = QL + done * CHW;
  const capturing = $out(f, 468, 500);
  const settle = $out(f, 498, 534, 0, 1);
  const flash = decay(f, 496, 3) * 0.5;
  const qScale = 1 - settle * 0.42;
  const qY = -settle * 118;

  return (
    <AbsoluteFill style={{ background: 'transparent' }}>
      {/* white capture flash */}
      <AbsoluteFill style={{ background: C.cyan, opacity: flash * 0.35, mixBlendMode: 'screen' }} />

      {/* boot log */}
      <div style={{ position: 'absolute', left: 150, top: 250, opacity: 0.9 }}>
        {LOG.map(([ts, k, v], i) => {
          const t0 = 302 + i * 19;
          const s = typed(f, t0, `${ts}  ${k} `, 1.4);
          const ok = f > t0 + 26;
          return (
            <div
              key={i}
              style={{
                fontFamily: F.mono,
                fontSize: 13,
                letterSpacing: 1.6,
                lineHeight: '30px',
                color: C.cyan,
                opacity: f > t0 ? 0.62 * $out(f, t0, t0 + 8) : 0,
                whiteSpace: 'pre',
              }}
            >
              {s}
              <span style={{ color: ok ? C.amber : C.cyanDim, opacity: ok ? 0.9 : 0.4, letterSpacing: 3 }}>
                {ok ? v : ''}
              </span>
            </div>
          );
        })}
        <div
          style={{
            fontFamily: F.mono,
            fontSize: 11,
            letterSpacing: 4,
            color: C.slate,
            opacity: $out(f, 340, 360) * 0.5,
            marginTop: 18,
          }}
        >
          AWAITING INPUT
        </div>
      </div>

      {/* query block */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 452,
          transform: `translateY(${qY}px) scale(${qScale})`,
          transformOrigin: '50% 50%',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, justifyContent: 'flex-start', paddingLeft: QL, opacity: $out(f, 344, 364) }}>
          <div style={{ width: 46, height: 1, background: C.cyan, opacity: 0.55 }} />
          <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 7, color: C.cyan, opacity: 0.7 }}>
            QUERY / 01
          </div>
          <div style={{ width: 46, height: 1, background: C.cyan, opacity: 0.55 }} />
        </div>

        <div
          style={{
            marginTop: 34,
            textAlign: 'left',
            paddingLeft: QL,
            fontFamily: F.sans,
            fontSize: 72,
            fontWeight: 500,
            letterSpacing: 2,
            color: C.ink,
            textShadow: `0 0 34px rgba(79,227,255,0.35), 0 0 90px rgba(79,227,255,0.14)`,
            whiteSpace: 'pre',
          }}
        >
          {typedStr}
          <span
            style={{
              display: 'inline-block',
              width: 7,
              height: 48,
              background: C.cyan,
              verticalAlign: '-8px',
              marginLeft: 4,
              opacity: f > typeStart - 20 && f < 470 ? (Math.floor(f / 7) % 2 ? 0.18 : 1) : 0,
              boxShadow: `0 0 22px ${C.cyan}`,
            }}
          />
        </div>
      </div>

      {/* input rail + voice bars */}
      <div style={{ position: 'absolute', left: QL - 40, top: 646, width: Q.length * CHW + 80, opacity: $out(f, 350, 372) }}>
        <div style={{ height: 1, background: `linear-gradient(to right, transparent, ${C.cyan}88, transparent)` }} />
        <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', height: 54, marginTop: 2 }}>
          {Array.from({ length: 52 }, (_, i) => {
            const x = QL - 40 + i * ((Q.length * CHW + 80) / 52) + 2;
            const near = Math.exp(-Math.abs(x - caretX) / 170);
            const live = f > typeStart - 10 && f < 470 ? 1 : 0.22;
            const amp = (0.22 + 0.78 * Math.abs(Math.sin(f * 0.33 + i * 0.9 + hash(i) * 3))) * (0.35 + near * 1.5);
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: Math.min(52, 4 + amp * 30 * live),
                  background: near > 0.5 ? C.cyan : C.cyanSoft,
                  opacity: 0.18 + near * 0.55 * live,
                }}
              />
            );
          })}
        </div>
      </div>

      {/* capture brackets */}
      <div
        style={{
          position: 'absolute',
          left: QL - 90,
          top: 380,
          width: Q.length * CHW + 180,
          height: 300,
          opacity: capturing,
        }}
      >
        <svg width={Q.length * CHW + 180} height={300} style={{ overflow: 'visible' }}>
          {[
            [0, 0, 1, 1],
            [Q.length * CHW + 180, 0, -1, 1],
            [0, 300, 1, -1],
            [Q.length * CHW + 180, 300, -1, -1],
          ].map(([x, y, sx, sy], i) => {
            const off = (1 - capturing) * 90;
            return (
              <path
                key={i}
                d={`M${x + off * sx} ${y} L${x} ${y} L${x} ${y + off * sy}`}
                stroke={C.cyan}
                strokeWidth={1.4}
                fill="none"
                opacity={0.8}
              />
            );
          })}
        </svg>
      </div>

      {/* split foreshadow */}
      <div
        style={{
          position: 'absolute',
          left: 958,
          top: 1080 - 1080 * $out(f, 516, 540),
          width: 1,
          height: 1080 * $out(f, 516, 540),
          background: `linear-gradient(to bottom, transparent, ${C.cyan}, transparent)`,
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 120,
          right: 120,
          top: 552,
          height: 1,
          background: `linear-gradient(to right, transparent, ${C.cyan}66, transparent)`,
          opacity: $out(f, 500, 530) * 0.7,
        }}
      />
    </AbsoluteFill>
  );
};
