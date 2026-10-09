import React from "react";
import {
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  type InteractivitySchema,
} from "remotion";
import { C, FONT } from "../theme";

type NodeCardProps = {
  readonly title: string;
  readonly accent: string;
  readonly sub: string;
  readonly width: number;
  readonly style?: React.CSSProperties;
};

const NodeCardInner: React.FC<NodeCardProps> = ({
  title,
  accent,
  sub,
  width,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <Interactive.Div
      style={{
        width,
        padding: "22px 28px",
        borderRadius: 22,
        border: `1px solid ${accent}66`,
        background: `linear-gradient(150deg, ${accent}26 0%, rgba(13,20,38,0.92) 62%)`,
        boxShadow: `0 18px 50px rgba(2,6,17,0.55), 0 0 34px ${accent}22`,
        opacity: interpolate(frame, [0, 0.4 * fps], [0, 1], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
        }),
        scale: interpolate(frame, [0, 0.9 * fps], [0.6, 1], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
          easing: Easing.spring({ damping: 13, mass: 0.9 }),
          output: "perceptual-scale",
        }),
        ...style,
      }}
    >
      <div
        style={{
          color: C.text,
          fontFamily: FONT,
          fontSize: 34,
          fontWeight: 700,
          letterSpacing: 1,
          textAlign: "center",
        }}
      >
        {title}
      </div>
      {sub ? (
        <div
          style={{
            color: accent,
            fontFamily: FONT,
            fontSize: 22,
            marginTop: 8,
            textAlign: "center",
            opacity: 0.9,
          }}
        >
          {sub}
        </div>
      ) : null}
    </Interactive.Div>
  );
};

const nodeCardSchema = {
  title: { type: "text-content", default: "节点", description: "节点标题" },
  accent: { type: "color", default: C.cyan, description: "主题色" },
  sub: { type: "text-content", default: "", description: "副标题（可空）" },
  width: { type: "number", default: 340, min: 200, max: 620, description: "宽度", hiddenFromList: false },
} as const satisfies InteractivitySchema;

/** 画布知识节点卡片：调用方用 from / durationInFrames 控制出场时间。 */
export const NodeCard = Interactive.withSchema({
  Component: NodeCardInner,
  componentName: "<NodeCard>",
  schema: nodeCardSchema,
  wrapInSequence: true,
});
