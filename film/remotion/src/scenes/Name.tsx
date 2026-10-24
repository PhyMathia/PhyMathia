import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, F } from '../theme';
import { $out, decay, hash } from '../lib';

const TITLE = 'PhyMathia'.split('');

export const Name: React.FC = () => {
  const f = useCurrentFrame();
  const hair = $out(f, 2222, 2252);
  const track = 0.30 - 0.22 * $out(f, 2228, 2330);
  const sub = $out(f, 2296, 2330);
  const dim = $out(f, 2312, 2348);
  const fade = $out(f, 2374, 2400);
  const flash = decay(f, 2220, 6);

  return (
    <AbsoluteFill style={{ background: '#000205' }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(50% 40% at 50% 50%, rgba(10,34,48,0.85), rgba(0,2,5,1) 72%)`,
          opacity: 1 - fade * 0.7,
        }}
      />

      {/* hairline */}
      <div
        style={{
          position: 'absolute',
          left: 960 - 500 * hair,
          top: 328,
          width: 1000 * hair,
          height: 1,
          background: `linear-gradient(to right, transparent, ${C.cyan}, transparent)`,
          opacity: 0.55,
        }}
      />

      {/* title */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 352,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'baseline',
          fontFamily: F.sans,
          fontSize: 132,
          fontWeight: 300,
          letterSpacing: `${track}em`,
          color: C.ink,
          textIndent: `${track}em`,
        }}
      >
        {TITLE.map((ch, i) => {
          const p = $out(f, 2228 + i * 7.2, 2262 + i * 7.2);
          return (
            <span
              key={i}
              style={{
                display: 'inline-block',
                opacity: p,
                transform: `translateY(${(1 - p) * 34}px)`,
                filter: p < 0.98 ? `blur(${(1 - p) * 9}px)` : undefined,
                textShadow: `0 ${0}px 40px rgba(79,227,255,${0.3 * p}), 0 0 120px rgba(79,227,255,${0.12 * p})`,
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>

      {/* chromatic ghost */}
      <div
        style={{
          position: 'absolute',
          left: 3,
          right: 0,
          top: 352,
          display: 'flex',
          justifyContent: 'center',
          fontFamily: F.sans,
          fontSize: 132,
          fontWeight: 300,
          letterSpacing: `${track}em`,
          textIndent: `${track}em`,
          color: C.rose,
          opacity: 0.10 * $out(f, 2260, 2300) * (1 - fade),
          mixBlendMode: 'screen',
          pointerEvents: 'none',
        }}
      >
        {TITLE.map((ch, i) => (
          <span key={i} style={{ display: 'inline-block', opacity: $out(f, 2228 + i * 7.2, 2262 + i * 7.2) }}>
            {ch}
          </span>
        ))}
      </div>

      {/* rule under title */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 560,
          display: 'flex',
          justifyContent: 'center',
          opacity: sub,
        }}
      >
        <div style={{ width: 120, height: 1, background: `${C.cyan}88` }} />
      </div>

      {/* chinese line */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 596,
          textAlign: 'center',
          fontFamily: F.sans,
          fontSize: 27,
          fontWeight: 400,
          letterSpacing: 10,
          color: C.ink,
          opacity: sub * 0.82,
        }}
      >
        物理绘万象之形，数学穷天地之理
      </div>

      {/* english line */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 666,
          textAlign: 'center',
          fontFamily: F.mono,
          fontSize: 10,
          letterSpacing: 10,
          color: C.cyan,
          opacity: dim * 0.6,
        }}
      >
        A QUESTION IN TWO LANGUAGES
      </div>

      {/* footer */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 92,
          display: 'flex',
          justifyContent: 'center',
          gap: 34,
          fontFamily: F.mono,
          fontSize: 9,
          letterSpacing: 6,
          color: C.slate,
          opacity: dim * 0.55,
        }}
      >
        <span>MADE WITH CODE</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>NO SAMPLES / NO FOOTAGE</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>DUAL-DOMAIN CANVAS</span>
      </div>

      {/* scan pass */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 1920 * $out(f, 2280, 2350),
          width: 3,
          background: `linear-gradient(to bottom, transparent, ${C.cyan}, transparent)`,
          opacity: 0.35,
          boxShadow: `0 0 40px ${C.cyan}`,
        }}
      />

      <AbsoluteFill style={{ background: C.cyan, opacity: flash * 0.4, mixBlendMode: 'screen' }} />
      <AbsoluteFill style={{ background: '#000205', opacity: fade }} />
      {hash(f) > 2 ? null : null}
    </AbsoluteFill>
  );
};
