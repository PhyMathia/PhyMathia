import React from 'react';
import { C, F } from '../theme';
import { $, $out, hash } from '../lib';

export const Subtitles: React.FC<{ f: number; items: { in: number; out: number; text: string }[] }> = ({
  f,
  items,
}) => {
  const cur = items.find((s) => f >= s.in - 6 && f <= s.out + 10);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 300,
        background: 'linear-gradient(to top, rgba(0,2,6,0.78), rgba(0,2,6,0.42) 40%, rgba(0,2,6,0.0) 100%)',
        pointerEvents: 'none',
      }}
    >
      {cur && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 92,
            textAlign: 'center',
            fontFamily: F.sans,
            fontSize: 38,
            fontWeight: 500,
            letterSpacing: 2.5,
            color: `rgba(234,246,255,${0.94 * $out(f, cur.in - 6, cur.in + 6)})`,
            transform: `translateY(${6 - 6 * $out(f, cur.in - 6, cur.in + 10)}px)`,
            textShadow: '0 2px 22px rgba(0,0,0,0.95), 0 0 40px rgba(0,0,0,0.8)',
          }}
        >
          {cur.text}
        </div>
      )}
    </div>
  );
};

export const Card: React.FC<{
  w: number;
  h: number;
  title?: string;
  active?: number;
  children?: React.ReactNode;
  accent?: string;
}> = ({ w, h, title, active = 0, children, accent = C.cyan }) => (
  <div
    style={{
      width: w,
      height: h,
      borderRadius: 12,
      border: `1px solid ${accent}${active > 0.5 ? 'cc' : '55'}`,
      background: `linear-gradient(158deg, rgba(9,24,36,0.94) 0%, rgba(4,11,19,0.96) 55%, rgba(6,16,26,0.94) 100%)`,
      boxShadow: `0 0 ${18 + active * 42}px ${accent}${active > 0.5 ? '33' : '14'}, inset 0 0 34px rgba(79,227,255,0.05)`,
      position: 'relative',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 22,
        height: 1,
        background: accent,
        opacity: 0.9,
      }}
    />
    {title && (
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 11,
          letterSpacing: 3,
          color: accent,
          opacity: 0.75,
          padding: '14px 18px 0',
        }}
      >
        {title}
      </div>
    )}
    {children}
  </div>
);

export const Chip: React.FC<{ label: string; accent?: string }> = ({ label, accent = C.cyan }) => (
  <div
    style={{
      fontFamily: F.mono,
      fontSize: 10,
      letterSpacing: 2,
      color: accent,
      border: `1px solid ${accent}44`,
      borderRadius: 3,
      padding: '4px 9px',
      background: `${accent}0d`,
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </div>
);

/** typing caret */
export const Caret: React.FC<{ f: number; on?: boolean; h?: number; color?: string }> = ({
  f,
  on = true,
  h = 26,
  color = C.cyan,
}) => (
  <span
    style={{
      display: 'inline-block',
      width: 10,
      height: h,
      marginLeft: 4,
      background: color,
      opacity: on ? (Math.floor(f / 8) % 2 === 0 ? 1 : 0.15) : 0,
      boxShadow: `0 0 14px ${color}`,
      verticalAlign: '-2px',
    }}
  />
);

/** corner brackets converging on a box */
export const Brackets: React.FC<{
  w: number;
  h: number;
  p: number;
  color?: string;
  inset?: number;
  size?: number;
}> = ({ w, h, p, color = C.cyan, inset = 0, size = 18 }) => {
  const off = (1 - p) * 40;
  const s = size;
  const pts: [number, number, number, number][] = [
    [0, 0, 1, 1],
    [w, 0, -1, 1],
    [0, h, 1, -1],
    [w, h, -1, -1],
  ];
  return (
    <svg width={w} height={h} style={{ position: 'absolute', left: -inset, top: -inset, overflow: 'visible' }}>
      {pts.map(([x, y, sx, sy], i) => (
        <path
          key={i}
          d={`M${x + off * sx} ${y} L${x} ${y} L${x} ${y + off * sy}`}
          stroke={color}
          strokeWidth={1.4}
          fill="none"
          opacity={0.55 + 0.45 * p}
        />
      ))}
    </svg>
  );
};

/** thin horizontal rule that draws in */
export const Rule: React.FC<{ w: number; p: number; color?: string; o?: number }> = ({
  w,
  p,
  color = C.cyan,
  o = 0.6,
}) => (
  <div
    style={{
      width: w * p,
      height: 1,
      background: `linear-gradient(to right, ${color}, ${color}22)`,
      opacity: o,
    }}
  />
);

/** background-less hairline label */
export const Kicker: React.FC<{ text: string; color?: string; size?: number; ls?: number }> = ({
  text,
  color = C.cyanDim,
  size = 10,
  ls = 5,
}) => (
  <div style={{ fontFamily: F.mono, fontSize: size, letterSpacing: ls, color, whiteSpace: 'nowrap' }}>{text}</div>
);

/** radar-like sweep ring */
export const Ring: React.FC<{ r: number; o: number; color?: string; dash?: boolean }> = ({
  r,
  o,
  color = C.cyan,
  dash = false,
}) => (
  <div
    style={{
      position: 'absolute',
      width: r * 2,
      height: r * 2,
      left: '50%',
      top: '50%',
      marginLeft: -r,
      marginTop: -r,
      borderRadius: '50%',
      border: `1px ${dash ? 'dashed' : 'solid'} ${color}`,
      opacity: o,
    }}
  />
);
