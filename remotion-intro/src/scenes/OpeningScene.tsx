import React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Aurora } from "../components/Aurora";
import { C, FONT, H, W } from "../theme";

const badges = ["本地部署", "零 CDN 依赖", "无需 API Key"];

export const OpeningScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phiScale = interpolate(frame, [0, 1.1 * fps], [0.4, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.spring({ damping: 11, mass: 0.9 }),
    output: "perceptual-scale",
  });
  const phiOpacity = interpolate(frame, [0, 0.4 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const rise = interpolate(frame, [0.35 * fps, 1.4 * fps], [70, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const titleIn = interpolate(frame, [0.35 * fps, 1.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const subIn = interpolate(frame, [1.0 * fps, 1.9 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const subY = interpolate(frame, [1.0 * fps, 1.9 * fps], [26, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const tagIn = interpolate(frame, [1.9 * fps, 2.7 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const badgeIn = interpolate(frame, [2.8 * fps, 3.8 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const badgeY = interpolate(frame, [2.8 * fps, 3.8 * fps], [24, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const ring = interpolate(frame, [0, 3 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  return (
    <AbsoluteFillWide>
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
            position: "relative",
            width: 150,
            height: 150,
            marginBottom: 40,
            opacity: phiOpacity,
            scale: phiScale,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: -18,
              borderRadius: "50%",
              border: `2px solid ${C.purpleEdge}`,
              opacity: ring * 0.8,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background:
                "radial-gradient(circle at 32% 28%, rgba(185,126,240,0.95), rgba(153,69,234,0.55) 58%, rgba(153,69,234,0.12) 100%)",
              boxShadow: "0 0 70px rgba(153,69,234,0.55)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 84,
              fontWeight: 700,
              fontFamily: FONT,
            }}
          >
            Φ
          </div>
        </div>

        <div style={{ translate: `0px ${rise}px`, opacity: titleIn }}>
          <div
            style={{
              fontFamily: FONT,
              fontSize: 128,
              fontWeight: 800,
              letterSpacing: 4,
              color: C.text,
              textAlign: "center",
              textShadow: "0 0 46px rgba(153,69,234,0.45)",
            }}
          >
            PhyMathia
          </div>
        </div>

        <div
          style={{
            fontFamily: FONT,
            fontSize: 44,
            color: C.cyan,
            marginTop: 18,
            letterSpacing: 6,
            opacity: subIn,
            translate: `0px ${subY}px`,
            textAlign: "center",
          }}
        >
          物理数学双域解释与可视化助手
        </div>

        <div
          style={{
            fontFamily: FONT,
            fontSize: 34,
            color: C.muted,
            marginTop: 34,
            letterSpacing: 3,
            opacity: tagIn,
            textAlign: "center",
          }}
        >
          让物理有直觉 · 让数学看得见
        </div>

        <div
          style={{
            display: "flex",
            gap: 26,
            marginTop: 66,
            opacity: badgeIn,
            translate: `0px ${badgeY}px`,
          }}
        >
          {badges.map((b) => (
            <div
              key={b}
              style={{
                fontFamily: FONT,
                fontSize: 26,
                color: C.text,
                letterSpacing: 2,
                padding: "14px 34px",
                borderRadius: 999,
                border: `1px solid ${C.panelEdge}`,
                background: C.panel,
              }}
            >
              {b}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFillWide>
  );
};

const AbsoluteFillWide: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => (
  <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
    {children}
  </div>
);
