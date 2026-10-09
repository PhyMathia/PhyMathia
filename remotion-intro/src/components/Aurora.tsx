import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

const blobs = [
  { x: 14, y: 20, r: 44, c: "rgba(153,69,234,0.30)", dx: 46, dy: -34, p: 0 },
  { x: 82, y: 76, r: 50, c: "rgba(34,211,238,0.20)", dx: -54, dy: 28, p: 40 },
  { x: 60, y: 6, r: 38, c: "rgba(185,126,240,0.16)", dx: 32, dy: 44, p: 80 },
  { x: 26, y: 90, r: 42, c: "rgba(56,189,248,0.15)", dx: -36, dy: -26, p: 120 },
];

const motes = [
  { x: 8, y: 30, s: 4, p: 10 },
  { x: 17, y: 68, s: 3, p: 90 },
  { x: 25, y: 18, s: 5, p: 150 },
  { x: 33, y: 84, s: 3, p: 40 },
  { x: 41, y: 44, s: 4, p: 200 },
  { x: 49, y: 12, s: 3, p: 120 },
  { x: 56, y: 72, s: 5, p: 260 },
  { x: 63, y: 30, s: 3, p: 60 },
  { x: 71, y: 58, s: 4, p: 180 },
  { x: 78, y: 22, s: 3, p: 300 },
  { x: 85, y: 80, s: 5, p: 230 },
  { x: 92, y: 40, s: 3, p: 140 },
  { x: 12, y: 52, s: 3, p: 320 },
  { x: 30, y: 60, s: 4, p: 20 },
  { x: 67, y: 90, s: 3, p: 280 },
  { x: 88, y: 62, s: 4, p: 170 },
];

/** 全片共用的深空底：渐变 + 极光斑 + 漂浮微尘 + 细点阵。 */
export const Aurora: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;

  return (
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(155deg, #070a12 0%, #0b1120 46%, #090e1c 100%)",
        fontFamily: "inherit",
      }}
    >
      {blobs.map((b, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `calc(${b.x}% + ${Math.sin(t * 0.5 + b.p) * b.dx}px)`,
            top: `calc(${b.y}% + ${Math.cos(t * 0.4 + b.p) * b.dy}px)`,
            width: b.r * 22,
            height: b.r * 22,
            marginLeft: -b.r * 11,
            marginTop: -b.r * 11,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${b.c} 0%, transparent 68%)`,
            filter: "blur(6px)",
          }}
        />
      ))}
      <AbsoluteFill
        style={{
          backgroundImage:
            "radial-gradient(rgba(148,163,184,0.10) 1.2px, transparent 1.2px)",
          backgroundSize: "44px 44px",
          opacity: 0.5,
        }}
      />
      {motes.map((m, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${m.x}%`,
            top: `${m.y + Math.sin(t * 0.3 + m.p) * 2}%`,
            width: m.s,
            height: m.s,
            borderRadius: "50%",
            backgroundColor:
              i % 3 === 0 ? "rgba(34,211,238,0.75)" : "rgba(185,126,240,0.7)",
            boxShadow: `0 0 ${m.s * 4}px ${
              i % 3 === 0 ? "rgba(34,211,238,0.55)" : "rgba(185,126,240,0.5)"
            }`,
            opacity:
              0.35 +
              0.35 *
                (0.5 +
                  0.5 * Math.sin(t * 1.6 + m.p * 0.05 + (frame % durationInFrames) * 0.01)),
          }}
        />
      ))}
    </AbsoluteFill>
  );
};
