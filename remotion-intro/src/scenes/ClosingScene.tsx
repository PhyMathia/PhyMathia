import React from "react";
import {
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Aurora } from "../components/Aurora";
import { C, FONT, MONO, H, W } from "../theme";

const termLines = [
  "$ pip install -r requirements.txt",
  "$ python3 src/main.py -p 5050",
  "→ http://localhost:5050  开始探索",
];

const badges = ["本地部署", "零 CDN 依赖", "无需 API Key"];

export const ClosingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleIn = interpolate(frame, [0, 0.8 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const termIn = interpolate(frame, [1.0 * fps, 1.7 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const badgesIn = interpolate(frame, [2.2 * fps, 3.0 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const ctaIn = interpolate(frame, [2.6 * fps, 3.4 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const footerIn = interpolate(frame, [3.2 * fps, 4.0 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  const typed = termLines.map((line, i) => {
    const start = (1.2 + i * 0.5) * fps;
    const chars = Math.floor(
      (frame - start) / ((0.9 * fps) / line.length)
    );
    return line.slice(0, Math.max(0, chars));
  });

  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
      <Aurora />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: 96,
            fontWeight: 800,
            color: C.text,
            letterSpacing: 4,
            textShadow: "0 0 46px rgba(153,69,234,0.5)",
            opacity: titleIn,
          }}
        >
          PhyMathia
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 34,
            color: C.cyan,
            letterSpacing: 6,
            marginTop: 16,
            opacity: titleIn,
          }}
        >
          让物理有直觉 · 让数学看得见
        </div>

        <div
          style={{
            marginTop: 62,
            padding: "34px 52px",
            borderRadius: 24,
            border: `1px solid ${C.panelEdge}`,
            background: "rgba(8,13,26,0.92)",
            boxShadow: "0 24px 60px rgba(2,6,17,0.55)",
            minWidth: 900,
            opacity: termIn,
          }}
        >
          {typed.map((line, i) => (
            <div
              key={termLines[i]}
              style={{
                fontFamily: MONO,
                fontSize: 30,
                lineHeight: 1.75,
                color: i === 2 ? C.green : C.text,
                whiteSpace: "pre",
              }}
            >
              {line}
              {typed[i] !== termLines[i] ? (
                <span style={{ color: C.purpleLift }}>▍</span>
              ) : null}
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            gap: 26,
            marginTop: 56,
            opacity: badgesIn,
          }}
        >
          {badges.map((b) => (
            <div
              key={b}
              style={{
                fontFamily: FONT,
                fontSize: 27,
                color: C.text,
                letterSpacing: 2,
                padding: "14px 36px",
                borderRadius: 999,
                border: `1px solid ${C.panelEdge}`,
                background: C.panel,
              }}
            >
              {b}
            </div>
          ))}
        </div>

        <div
          style={{
            fontFamily: FONT,
            fontSize: 30,
            color: C.muted,
            letterSpacing: 3,
            marginTop: 56,
            opacity: ctaIn,
          }}
        >
          新建一块画布，从「什么是简谐运动」开始
        </div>

        <div
          style={{
            fontFamily: MONO,
            fontSize: 26,
            color: C.faint,
            letterSpacing: 8,
            marginTop: 58,
            opacity: footerIn,
          }}
        >
          Phy · Math · Utopia
        </div>
      </div>
    </div>
  );
};
