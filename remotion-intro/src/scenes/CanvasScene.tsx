import React from "react";
import {
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Aurora } from "../components/Aurora";
import { NodeCard } from "../components/NodeCard";
import { C, FONT, H, W } from "../theme";

const CENTER = { x: 960, y: 548 };

const children = [
  { label: "追问", sub: "物理直觉 · 气泡上", x: 480, y: 296, accent: C.cyan, from: 1.0 },
  { label: "没看懂", sub: "换个讲法再讲", x: 1440, y: 296, accent: C.amber, from: 1.5 },
  { label: "自由续问", sub: "想到哪问到哪", x: 960, y: 216, accent: C.blue, from: 2.0 },
  { label: "苏格拉底回答", sub: "先作答 · 再判断", x: 480, y: 800, accent: C.green, from: 2.5 },
  { label: "进阶学习", sub: "沿知识链向上", x: 1440, y: 800, accent: C.purpleLift, from: 3.0 },
];

const tools = ["全局搜索", "一键自动整理", "多画布保存", "高清 PNG 导出"];

export const CanvasScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headIn = interpolate(frame, [0, 0.6 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const toolsIn = interpolate(frame, [3.6 * fps, 4.4 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
      <Aurora />
      <div
        style={{
          position: "absolute",
          top: 74,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: FONT,
          fontSize: 44,
          fontWeight: 800,
          color: C.text,
          letterSpacing: 4,
          opacity: headIn,
        }}
      >
        探索网画布
        <span style={{ color: C.faint, fontSize: 28, fontWeight: 400, marginLeft: 22 }}>
          学到哪里，网就织到哪里
        </span>
      </div>

      <svg
        width={W}
        height={H}
        style={{ position: "absolute", left: 0, top: 0 }}
      >
        {children.map((c) => {
          const inAt = (c.from + 0.9) * fps;
          const o = interpolate(frame, [inAt, inAt + 0.45 * fps], [1, 0], {
            extrapolateRight: "clamp",
            extrapolateLeft: "clamp",
          });
          return (
            <path
              key={c.label}
              d={`M ${CENTER.x} ${CENTER.y} Q ${(CENTER.x + c.x) / 2} ${
                (CENTER.y + c.y) / 2 - 60
              } ${c.x} ${c.y}`}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={o}
              stroke={c.accent}
              strokeWidth={3}
              fill="none"
              opacity={0.75}
            />
          );
        })}
      </svg>

      {/* 中心节点 */}
      <div
        style={{
          position: "absolute",
          left: CENTER.x - 210,
          top: CENTER.y - 62,
          width: 420,
          padding: "26px 20px",
          borderRadius: 26,
          border: `1px solid ${C.purpleEdge}`,
          background:
            "linear-gradient(150deg, rgba(153,69,234,0.34) 0%, rgba(13,20,38,0.94) 60%)",
          boxShadow: "0 20px 60px rgba(2,6,17,0.6), 0 0 46px rgba(153,69,234,0.3)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: 38,
            fontWeight: 800,
            color: C.text,
          }}
        >
          什么是简谐运动
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 22,
            color: C.purpleLift,
            marginTop: 8,
            letterSpacing: 2,
          }}
        >
          一次提问 · 长出一簇
        </div>
      </div>

      {children.map((c, i) => (
        <div
          key={c.label}
          style={{
            position: "absolute",
            left: c.x,
            top: c.y,
            marginLeft: -170,
            marginTop: -55,
          }}
        >
          <NodeCard
            name={`Node ${i + 1}`}
            title={c.label}
            sub={c.sub}
            accent={c.accent}
            width={340}
            from={c.from * fps}
            durationInFrames={(14 - c.from) * fps}
            premountFor={fps}
          />
        </div>
      ))}

      <div
        style={{
          position: "absolute",
          bottom: 66,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 22,
          opacity: toolsIn,
        }}
      >
        {tools.map((t) => (
          <div
            key={t}
            style={{
              fontFamily: FONT,
              fontSize: 26,
              color: C.muted,
              letterSpacing: 2,
              padding: "12px 28px",
              borderRadius: 999,
              border: `1px solid ${C.panelEdge}`,
              background: C.panel,
            }}
          >
            {t}
          </div>
        ))}
      </div>
    </div>
  );
};
