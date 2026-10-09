import React from "react";
import {
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Aurora } from "../components/Aurora";
import { C, FONT, MONO, H, W } from "../theme";

const cards = [
  {
    icon: "◈",
    accent: C.cyan,
    title: "知识总览",
    lines: ["知识点自动入库", "按主题与掌握度生长"],
  },
  {
    icon: "∑",
    accent: C.purpleLift,
    title: "公式速查",
    lines: ["回答中的公式自动收集", "每条附中文说明"],
  },
  {
    icon: "▣",
    accent: C.green,
    title: "知识检测",
    lines: ["基于你的画布出题", "错题回顾 + 掌握统计"],
  },
  {
    icon: "◐",
    accent: C.amber,
    title: "用户画像",
    lines: ["记住学习目标与薄弱点", "透明可控 · 一键可清除"],
  },
];

export const LearningScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headIn = interpolate(frame, [0, 0.6 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const spotlightIn = interpolate(frame, [4.0 * fps, 4.8 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const spotlightY = interpolate(frame, [4.0 * fps, 4.8 * fps], [50, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
      <Aurora />
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: headIn,
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: 48,
            fontWeight: 800,
            color: C.text,
            letterSpacing: 4,
          }}
        >
          会积累的学习系统
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 28,
            color: C.faint,
            letterSpacing: 3,
            marginTop: 16,
          }}
        >
          每问一次，知识就沉淀一分
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 300,
          left: 120,
          right: 120,
          display: "flex",
          gap: 34,
        }}
      >
        {cards.map((card, i) => {
          const at = 1.0 * fps + i * 0.4 * fps;
          const o = interpolate(frame, [at, at + 0.55 * fps], [0, 1], {
            extrapolateRight: "clamp",
            extrapolateLeft: "clamp",
          });
          const y = interpolate(frame, [at, at + 0.55 * fps], [56, 0], {
            extrapolateRight: "clamp",
            extrapolateLeft: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          });
          return (
            <div
              key={card.title}
              style={{
                flex: 1,
                padding: "38px 34px",
                borderRadius: 26,
                border: `1px solid ${C.panelEdge}`,
                background: `linear-gradient(165deg, ${card.accent}1f 0%, rgba(13,20,38,0.92) 58%)`,
                boxShadow: "0 20px 50px rgba(2,6,17,0.5)",
                opacity: o,
                translate: `0px ${y}px`,
              }}
            >
              <div
                style={{
                  width: 74,
                  height: 74,
                  borderRadius: 20,
                  background: `${card.accent}26`,
                  border: `1px solid ${card.accent}66`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 40,
                  color: card.accent,
                  fontFamily: FONT,
                  marginBottom: 26,
                }}
              >
                {card.icon}
              </div>
              <div
                style={{
                  fontFamily: FONT,
                  fontSize: 36,
                  fontWeight: 800,
                  color: C.text,
                  letterSpacing: 2,
                  marginBottom: 18,
                }}
              >
                {card.title}
              </div>
              {card.lines.map((l) => (
                <div
                  key={l}
                  style={{
                    fontFamily: FONT,
                    fontSize: 25,
                    color: C.muted,
                    lineHeight: 1.6,
                  }}
                >
                  {l}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* 公式 spotlight */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 96,
          display: "flex",
          justifyContent: "center",
          opacity: spotlightIn,
          translate: `0px ${spotlightY}px`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 46,
            padding: "30px 60px",
            borderRadius: 26,
            border: `1px solid ${C.purpleEdge}`,
            background:
              "linear-gradient(140deg, rgba(153,69,234,0.22), rgba(10,16,32,0.92))",
            boxShadow: "0 20px 54px rgba(2,6,17,0.55)",
          }}
        >
          <div
            style={{
              fontFamily: MONO,
              fontSize: 56,
              fontWeight: 700,
              color: C.text,
              letterSpacing: 2,
            }}
          >
            F = −k · x
          </div>
          <div
            style={{
              fontFamily: FONT,
              fontSize: 26,
              color: C.muted,
              lineHeight: 1.6,
            }}
          >
            胡克定律 · 劲度系数 k
            <br />
            公式自动收进速查，随问随查
          </div>
        </div>
      </div>
    </div>
  );
};
