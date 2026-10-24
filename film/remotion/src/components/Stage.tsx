import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, BEAT } from '../theme';
import { decay, hash } from '../lib';

const STARS = Array.from({ length: 120 }, (_, i) => ({
  x: hash(i * 3.11) * 1920,
  y: hash(i * 7.77) * 1080,
  r: 0.5 + hash(i * 5.3) * 1.7,
  ph: hash(i * 2.7) * 6.283,
  sp: 0.5 + hash(i * 9.1) * 1.8,
}));

const NOISE =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='160' height='160' filter='url(%23n)' opacity='0.55'/></svg>\")";

const pulseIn = (f: number, a: number, b: number, k: number) =>
  f >= a && f < b ? Math.exp(-((f - a) % BEAT) / 2.6) * k : 0;

export const energyAt = (f: number) =>
  Math.max(
    pulseIn(f, 540, 1020, 0.55),
    pulseIn(f, 1020, 1380, 0.7),
    pulseIn(f, 1380, 1620, 0.22),
    pulseIn(f, 1860, 2200, 0.5),
    pulseIn(f, 2220, 2400, 0.45)
  );

export const Stage: React.FC<{ f: number }> = ({ f }) => {
  const energy = energyAt(f);
  const gridScroll = (f * 1.15) % 132;
  const glitchOn = hash(Math.floor(f / 2.5)) > 0.94;
  const gy = 120 + hash(Math.floor(f / 2.5) * 3.3) * 760;
  const kick = decay(f, 0, 60) * 0.5;

  return (
    <AbsoluteFill style={{ background: '#000205', overflow: 'hidden' }}>
      {/* deep field */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 85% at 50% 46%, rgba(10,26,40,1) 0%, rgba(5,12,20,1) 34%, rgba(2,5,9,1) 66%, #000205 100%)`,
        }}
      />
      {/* slow light bloom */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(45% 32% at 50% ${52 + Math.sin(f / 90) * 3}%, rgba(79,227,255,${0.055 + energy * 0.09}), transparent 70%)`,
          mixBlendMode: 'screen',
        }}
      />

      {/* horizon + perspective floor */}
      <div
        style={{
          position: 'absolute',
          left: -600,
          right: -600,
          top: '57.5%',
          height: 900,
          perspective: '520px',
          perspectiveOrigin: '50% 0%',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: 'rotateX(75deg) scale(1.9)',
            transformOrigin: '50% 0%',
            backgroundImage: `linear-gradient(to right, rgba(79,227,255,${0.16 + energy * 0.12}) 1px, transparent 1px), linear-gradient(to bottom, rgba(79,227,255,${0.10 + energy * 0.10}) 1px, transparent 1px)`,
            backgroundSize: '132px 132px',
            backgroundPosition: `0px ${gridScroll}px`,
            maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.35) 45%, transparent 78%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.35) 45%, transparent 78%)',
          }}
        />
      </div>
      {/* horizon line */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '57.4%',
          height: 1,
          background: `linear-gradient(to right, transparent, rgba(79,227,255,${0.28 + energy * 0.4}), transparent)`,
          boxShadow: `0 0 ${24 + energy * 30}px rgba(79,227,255,0.35)`,
        }}
      />

      {/* stars */}
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        {STARS.map((s, i) => {
          const tw = 0.18 + 0.62 * Math.abs(Math.sin(f * 0.017 * s.sp + s.ph));
          return (
            <circle
              key={i}
              cx={s.x}
              cy={s.y - ((f * (0.12 + s.r * 0.05)) % 120)}
              r={s.r}
              fill={i % 11 === 0 ? C.amber : C.cyanSoft}
              opacity={tw * 0.7}
            />
          );
        })}
      </svg>

      {/* vertical scanner beams */}
      {[0, 1].map((i) => {
        const x = ((f * (0.9 + i * 0.35) + i * 900) % 2300) - 190;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: x,
              width: 180,
              background: `linear-gradient(to right, transparent, rgba(79,227,255,${0.02 + energy * 0.03}), transparent)`,
            }}
          />
        );
      })}

      {/* glitch band */}
      {glitchOn && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: gy,
            height: 2 + hash(f) * 8,
            background: 'rgba(79,227,255,0.12)',
            mixBlendMode: 'screen',
            opacity: 0.7,
          }}
        />
      )}

      {/* scanlines */}
      <AbsoluteFill
        style={{
          backgroundImage:
            'repeating-linear-gradient(to bottom, rgba(255,255,255,0.035) 0px, rgba(255,255,255,0.035) 1px, transparent 1px, transparent 3px)',
          opacity: 0.55,
          mixBlendMode: 'overlay',
        }}
      />
      {/* grain */}
      <AbsoluteFill
        style={{
          backgroundImage: NOISE,
          backgroundPosition: `${(f * 37) % 160}px ${(f * 53) % 160}px`,
          opacity: 0.05,
          mixBlendMode: 'overlay',
        }}
      />
      {/* vignette */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(78% 68% at 50% 50%, transparent 42%, rgba(0,0,0,0.55) 78%, rgba(0,0,0,0.9) 100%)',
        }}
      />
      {/* beat bloom */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 50% at 50% 50%, rgba(130,240,255,${0.05 + energy * 0.10}), transparent 68%)`,
          mixBlendMode: 'screen',
          opacity: 0.9 - kick,
        }}
      />
    </AbsoluteFill>
  );
};
