import React from 'react';
import { C, F } from '../theme';
import { hash, timecode, $out, $ } from '../lib';

const Corner: React.FC<{ x: number; y: number; sx: number; sy: number; o?: number }> = ({
  x,
  y,
  sx,
  sy,
  o = 0.55,
}) => (
  <g opacity={o}>
    <path d={`M${x} ${y + 26 * sy} L${x} ${y} L${x + 26 * sx} ${y}`} stroke={C.cyan} strokeWidth={1.4} fill="none" />
  </g>
);

export const Hud: React.FC<{ f: number; chapter: string; chapterStart: number }> = ({ f, chapter, chapterStart }) => {
  const t = f - chapterStart;
  const wipe = $out(t, 0, 18, 0, 1);
  const blink = Math.floor(f / 7) % 2 === 0;
  const meter = [0.35, 0.62, 0.44, 0.8, 0.3, 0.55];
  const stats = [
    ['NODES', String(1284 + Math.floor(f * 0.31)).padStart(4, '0')],
    ['ENTROPY', (0.618 + Math.sin(f / 22) * 0.014).toFixed(3)],
    ['SCALE', `${(1 + ourScale(f)).toFixed(3)}×`],
  ];

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* frame */}
      <div style={{ position: 'absolute', inset: 26, border: `1px solid rgba(79,227,255,0.10)` }} />
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        <Corner x={26} y={26} sx={1} sy={1} />
        <Corner x={1894} y={26} sx={-1} sy={1} />
        <Corner x={26} y={1054} sx={1} sy={-1} />
        <Corner x={1894} y={1054} sx={-1} sy={-1} />
        {/* left ruler */}
        {Array.from({ length: 14 }, (_, i) => (
          <g key={i} opacity={0.28}>
            <line x1={26} x2={i % 2 === 0 ? 42 : 34} y1={150 + i * 62} y2={150 + i * 62} stroke={C.cyan} strokeWidth={1} />
            {i % 2 === 0 && (
              <text x={48} y={154 + i * 62} fill={C.cyan} fontSize={9} fontFamily={F.mono} opacity={0.7}>
                {String(i * 10).padStart(3, '0')}
              </text>
            )}
          </g>
        ))}
      </svg>

      {/* brand */}
      <div style={{ position: 'absolute', left: 56, top: 46, fontFamily: F.mono }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ width: 7, height: 7, background: C.cyan, boxShadow: `0 0 12px ${C.cyan}` }} />
          <div style={{ color: C.ink, fontSize: 17, letterSpacing: 7, fontWeight: 500 }}>PhyMathia</div>
        </div>
        <div style={{ color: C.cyanDim, fontSize: 9, letterSpacing: 4, marginTop: 8 }}>
          NEURAL CANVAS / v1.4.1
        </div>
      </div>

      {/* chapter */}
      <div style={{ position: 'absolute', left: 56, top: 104, fontFamily: F.mono, display: 'flex', gap: 12 }}>
        <div style={{ width: 34 * wipe, height: 1, background: C.cyan, alignSelf: 'center', opacity: 0.7 }} />
        <div style={{ color: C.cyan, fontSize: 10, letterSpacing: 5, opacity: 0.85 * wipe }}>
          {chapter}
        </div>
      </div>

      {/* timecode */}
      <div
        style={{
          position: 'absolute',
          right: 56,
          top: 46,
          fontFamily: F.mono,
          textAlign: 'right',
          color: C.cyanDim,
          fontSize: 11,
          letterSpacing: 3,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: 6,
              background: C.rose,
              opacity: blink ? 0.95 : 0.15,
              boxShadow: `0 0 10px ${C.rose}`,
            }}
          />
          <span style={{ color: C.ink, opacity: 0.8 }}>{timecode(f)}</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 9, letterSpacing: 3.5 }}>FRAME {String(f).padStart(4, '0')}</div>
      </div>

      {/* stats */}
      <div
        style={{
          position: 'absolute',
          left: 56,
          bottom: 48,
          fontFamily: F.mono,
          fontSize: 9,
          letterSpacing: 2.6,
          color: C.cyanDim,
          display: 'flex',
          gap: 26,
        }}
      >
        {stats.map(([k, v]) => (
          <div key={k}>
            <div style={{ opacity: 0.55 }}>{k}</div>
            <div style={{ color: C.ink, opacity: 0.72, marginTop: 5 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* meter */}
      <div
        style={{
          position: 'absolute',
          right: 56,
          bottom: 48,
          display: 'flex',
          gap: 4,
          alignItems: 'flex-end',
          height: 40,
        }}
      >
        {meter.map((m, i) => {
          const h = 8 + Math.abs(Math.sin(f * 0.22 + i * 1.1)) * 30 * (0.5 + m);
          return (
            <div
              key={i}
              style={{
                width: 3,
                height: h,
                background: i > 3 ? C.amber : C.cyan,
                opacity: 0.5,
              }}
            />
          );
        })}
      </div>
    </div>
  );
};

const ourScale = (f: number) => 0.5 + ($(f, 0, 2400, 0, 0.42) as number);
