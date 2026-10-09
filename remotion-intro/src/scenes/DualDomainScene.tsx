import React from "react";
import {
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Aurora } from "../components/Aurora";
import { C, FONT, H, W } from "../theme";

const physicsLines = [
  "像荡秋千：位移随时间往复",
  "能量在动能与势能之间来回流动",
  "回复力永远指向平衡位置",
];

const mathLines = [
  "d²x / dt² = −ω²·x",
  "通解 x = A·sin(ωt + φ)",
  "频率 ω 由系统本身决定",
];

const modules = [
  "核心摘要",
  "物理直觉",
  "数学本质",
  "知识图谱",
  "交互可视化",
  "延伸思考",
];

export const DualDomainScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const qIn = interpolate(frame, [0, 0.7 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const qY = interpolate(frame, [0, 0.7 * fps], [40, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const leftX = interpolate(frame, [0.8 * fps, 1.7 * fps], [-260, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const rightX = interpolate(frame, [0.8 * fps, 1.7 * fps], [260, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const cardsIn = interpolate(frame, [0.8 * fps, 1.7 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const headingIn = interpolate(frame, [7.4 * fps, 8.2 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
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
          paddingTop: 92,
        }}
      >
        <div
          style={{
            opacity: qIn,
            translate: `0px ${qY}px`,
            fontFamily: FONT,
            fontSize: 46,
            fontWeight: 700,
            color: C.text,
            letterSpacing: 2,
            padding: "22px 56px",
            borderRadius: 999,
            border: `1px solid ${C.panelEdge}`,
            background: C.panel,
            boxShadow: "0 14px 44px rgba(2,6,17,0.5)",
          }}
        >
          「 什么是简谐运动？ 」
        </div>

        <div
          style={{
            display: "flex",
            gap: 70,
            marginTop: 74,
            opacity: cardsIn,
          }}
        >
          <DomainCard
            accent={C.cyan}
            wash={C.cyanWash}
            edge={C.cyanEdge}
            title="物理直觉"
            lines={physicsLines}
            translate={`${leftX}px 0px`}
            base={2.1 * fps}
            fps={fps}
          />
          <DomainCard
            accent={C.purpleLift}
            wash={C.purpleWash}
            edge={C.purpleEdge}
            title="数学本质"
            lines={mathLines}
            translate={`${rightX}px 0px`}
            base={2.4 * fps}
            fps={fps}
          />
        </div>

        <div
          style={{
            marginTop: 84,
            opacity: headingIn,
            fontFamily: FONT,
            fontSize: 28,
            color: C.faint,
            letterSpacing: 3,
            textAlign: "center",
          }}
        >
          一次回答，固定六个模块
        </div>
        <div
          style={{
            display: "flex",
            gap: 22,
            marginTop: 26,
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: 1560,
          }}
        >
          {modules.map((m, i) => {
            const inAt = 7.9 * fps + i * 0.18 * fps;
            const o = interpolate(frame, [inAt, inAt + 0.5 * fps], [0, 1], {
              extrapolateRight: "clamp",
              extrapolateLeft: "clamp",
            });
            const y = interpolate(frame, [inAt, inAt + 0.5 * fps], [20, 0], {
              extrapolateRight: "clamp",
              extrapolateLeft: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            });
            return (
              <div
                key={m}
                style={{
                  fontFamily: FONT,
                  fontSize: 27,
                  color: C.text,
                  letterSpacing: 2,
                  padding: "13px 30px",
                  borderRadius: 16,
                  border: `1px solid ${C.panelEdge}`,
                  background: C.panel,
                  opacity: o,
                  translate: `0px ${y}px`,
                }}
              >
                {m}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const DomainCard: React.FC<{
  accent: string;
  wash: string;
  edge: string;
  title: string;
  lines: string[];
  translate: string;
  base: number;
  fps: number;
}> = ({ accent, wash, edge, title, lines, translate, base, fps }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        width: 640,
        padding: "40px 46px 46px",
        borderRadius: 30,
        border: `1px solid ${edge}`,
        background: `linear-gradient(160deg, ${wash} 0%, rgba(13,20,38,0.9) 55%)`,
        boxShadow: "0 24px 60px rgba(2,6,17,0.55)",
        translate,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 30,
        }}
      >
        <div
          style={{
            width: 14,
            height: 40,
            borderRadius: 7,
            backgroundColor: accent,
            boxShadow: `0 0 22px ${accent}`,
          }}
        />
        <div
          style={{
            fontFamily: FONT,
            fontSize: 44,
            fontWeight: 800,
            color: accent,
            letterSpacing: 4,
          }}
        >
          {title}
        </div>
      </div>
      {lines.map((line, i) => {
        const inAt = base + i * 0.55 * fps;
        const o = interpolate(frame, [inAt, inAt + 0.5 * fps], [0, 1], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
        });
        const x = interpolate(frame, [inAt, inAt + 0.5 * fps], [28, 0], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        });
        return (
          <div
            key={line}
            style={{
              fontFamily: i === 1 ? MONO_INHERIT : FONT,
              fontSize: 32,
              color: C.text,
              lineHeight: 1.5,
              padding: "14px 22px",
              marginBottom: 14,
              borderRadius: 16,
              background: "rgba(148,163,184,0.08)",
              opacity: o,
              translate: `${x}px 0px`,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

const MONO_INHERIT = '"Noto Sans Mono CJK SC", Menlo, monospace';
