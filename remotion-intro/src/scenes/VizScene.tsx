import React from "react";
import {
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Aurora } from "../components/Aurora";
import { C, FONT, MONO, H, W } from "../theme";

/** 单个滑块：label + 轨道 + 旋钮。knob 位置由调用方随时间驱动。 */
const Slider: React.FC<{
  label: string;
  value: string;
  accent: string;
  knob: number;
  inAt: number;
}> = ({ label, value, accent, knob, inAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = interpolate(frame, [inAt, inAt + 0.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const x = interpolate(frame, [inAt, inAt + 0.5 * fps], [30, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const trackW = 560;
  const knobX = 24 + knob * (trackW - 48);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 22,
        marginBottom: 44,
        opacity: o,
        translate: `${x}px 0px`,
      }}
    >
      <div
        style={{
          width: 170,
          fontFamily: MONO,
          fontSize: 30,
          color: C.muted,
          letterSpacing: 1,
        }}
      >
        {label}
      </div>
      <div
        style={{
          position: "relative",
          width: trackW,
          height: 12,
          borderRadius: 999,
          background: "rgba(148,163,184,0.18)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 24,
            top: 0,
            bottom: 0,
            width: knobX - 24,
            borderRadius: 999,
            background: accent,
            boxShadow: `0 0 18px ${accent}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: knobX - 17,
            top: -17,
            width: 34,
            height: 34,
            borderRadius: "50%",
            background: "#f8fafc",
            border: `5px solid ${accent}`,
            boxShadow: "0 6px 18px rgba(2,6,17,0.6)",
          }}
        />
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 30,
          color: accent,
          width: 110,
        }}
      >
        {value}
      </div>
    </div>
  );
};

export const VizScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const t = frame / fps;
  const amp = 0.55 + 0.45 * Math.sin(t * 0.9);
  const omega = 1.4 + 0.9 * Math.sin(t * 0.55 + 1.2);
  const ampNorm = (amp - 0.1) / 0.9;
  const omegaNorm = (omega - 1.4) / 0.9;

  const headIn = interpolate(frame, [0, 0.6 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const cardIn = interpolate(frame, [0.5 * fps, 1.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const cardY = interpolate(frame, [0.5 * fps, 1.3 * fps], [60, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const captionIn = interpolate(frame, [2.0 * fps, 2.9 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // 曲线：x 从 0 到 4π，y = A·sin(ωx)
  const cw = 1020;
  const ch = 560;
  const padX = 60;
  const padY = 56;
  const pts: string[] = [];
  for (let i = 0; i <= 160; i++) {
    const p = i / 160;
    const x = padX + p * (cw - padX * 2);
    const phase = p * Math.PI * 4 * omega;
    const y = ch / 2 - Math.sin(phase) * amp * (ch / 2 - padY - 14);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const gridLines = [0.2, 0.4, 0.6, 0.8].map((g) => ({
    x: padX + g * (cw - padX * 2),
  }));
  const markerX = padX + 0.63 * (cw - padX * 2);
  const markerPhase = 0.63 * Math.PI * 4 * omega;
  const markerY =
    ch / 2 - Math.sin(markerPhase) * amp * (ch / 2 - padY - 14);

  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
      <Aurora />
      <div
        style={{
          position: "absolute",
          top: 78,
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
        交互可视化
        <span style={{ color: C.faint, fontSize: 28, fontWeight: 400, marginLeft: 22 }}>
          拖滑块，曲线实时重算
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          left: 120,
          top: 212,
          width: cw + 48,
          height: ch + 48,
          borderRadius: 30,
          border: `1px solid ${C.panelEdge}`,
          background: "rgba(10,16,32,0.85)",
          boxShadow: "0 24px 60px rgba(2,6,17,0.55)",
          opacity: cardIn,
          translate: `0px ${cardY}px`,
          padding: 24,
        }}
      >
        <svg width={cw} height={ch}>
          <line
            x1={padX}
            y1={ch / 2}
            x2={cw - padX}
            y2={ch / 2}
            stroke="rgba(148,163,184,0.35)"
            strokeWidth={2}
          />
          {gridLines.map((g) => (
            <line
              key={g.x}
              x1={g.x}
              y1={28}
              x2={g.x}
              y2={ch - 28}
              stroke="rgba(148,163,184,0.12)"
              strokeWidth={1.5}
            />
          ))}
          <polyline
            points={pts.join(" ")}
            fill="none"
            stroke={C.cyan}
            strokeWidth={5}
            strokeLinecap="round"
            style={{ filter: "drop-shadow(0 0 14px rgba(34,211,238,0.55))" }}
          />
          <circle
            cx={markerX}
            cy={markerY}
            r={11}
            fill="#f8fafc"
            stroke={C.cyan}
            strokeWidth={4}
          />
        </svg>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 26,
            color: C.muted,
            textAlign: "center",
            marginTop: 6,
          }}
        >
          y = A · sin( ωx )
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 1310,
          top: 260,
          padding: "46px 54px",
          borderRadius: 30,
          border: `1px solid ${C.panelEdge}`,
          background: C.panel,
          boxShadow: "0 24px 60px rgba(2,6,17,0.55)",
          opacity: cardIn,
          translate: `0px ${cardY}px`,
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: 30,
            color: C.faint,
            letterSpacing: 3,
            marginBottom: 40,
          }}
        >
          参数随拖随变
        </div>
        <Slider
          label="振幅 A"
          value={amp.toFixed(2)}
          accent={C.cyan}
          knob={ampNorm}
          inAt={1.4 * fps}
        />
        <Slider
          label="频率 ω"
          value={omega.toFixed(2)}
          accent={C.purpleLift}
          knob={omegaNorm}
          inAt={1.7 * fps}
        />
        <div
          style={{
            fontFamily: FONT,
            fontSize: 24,
            color: C.muted,
            letterSpacing: 2,
            lineHeight: 1.7,
            opacity: captionIn,
          }}
        >
          AI 生成 · 主题跟随主应用
          <br />
          可全屏 · 可复制源码
        </div>
      </div>
    </div>
  );
};
