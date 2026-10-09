import React from "react";
import {
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Aurora } from "../components/Aurora";
import { C, FONT, MONO, H, W } from "../theme";

const ops = [
  { kind: "create_node", arg: "进阶：受迫振动" },
  { kind: "create_node", arg: "进阶：共振" },
  { kind: "add_edge", arg: "简谐运动 → 共振" },
];

export const PhiScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headIn = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  const userIn = (at: number) => ({
    opacity: interpolate(frame, [at, at + 0.45 * fps], [0, 1], {
      extrapolateRight: "clamp",
      extrapolateLeft: "clamp",
    }),
    translate: `0px ${interpolate(frame, [at, at + 0.45 * fps], [26, 0], {
      extrapolateRight: "clamp",
      extrapolateLeft: "clamp",
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    })}px`,
  });

  const typingVisible = frame >= 1.6 * fps && frame < 2.5 * fps;
  const typingOpacity = interpolate(
    frame,
    [1.6 * fps, 1.9 * fps, 2.3 * fps, 2.5 * fps],
    [0, 1, 1, 0],
    { extrapolateRight: "clamp", extrapolateLeft: "clamp" }
  );

  const applyGlow = interpolate(frame, [5.4 * fps, 6.1 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // 微缩图节点：预览（虚线）→ 应用（实心弹出）→ 撤销（缩没）
  const previewIn = interpolate(frame, [2.8 * fps, 3.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const applyPop = interpolate(frame, [6.0 * fps, 6.8 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.spring({ damping: 12, mass: 0.9 }),
  });
  const undoOut = interpolate(frame, [8.4 * fps, 9.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const edgeIn = interpolate(frame, [6.0 * fps, 7.0 * fps], [1, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const edgeOut = interpolate(frame, [8.4 * fps, 9.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  const undoMsgIn = interpolate(frame, [7.8 * fps, 8.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const rolledIn = interpolate(frame, [9.6 * fps, 10.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const captionIn = interpolate(frame, [10.3 * fps, 11.0 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  const previewNodes = [
    { x: 1074, y: 232, title: "进阶：受迫振动" },
    { x: 1434, y: 232, title: "进阶：共振" },
  ];

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
        Φ 网络助手
        <span style={{ color: C.faint, fontSize: 28, fontWeight: 400, marginLeft: 22 }}>
          自然语言改图 · 先预览后应用
        </span>
      </div>

      {/* 左：对话面板 */}
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 196,
          width: 830,
          height: 664,
          borderRadius: 30,
          border: `1px solid ${C.panelEdge}`,
          background: "rgba(10,16,32,0.86)",
          boxShadow: "0 24px 60px rgba(2,6,17,0.55)",
          padding: "34px 40px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background:
                "radial-gradient(circle at 32% 28%, rgba(185,126,240,0.95), rgba(153,69,234,0.6))",
              color: "#fff",
              fontFamily: FONT,
              fontSize: 26,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Φ
          </div>
          <div style={{ fontFamily: FONT, fontSize: 28, color: C.text }}>
            网络整理模式
          </div>
          <div
            style={{
              marginLeft: "auto",
              fontFamily: FONT,
              fontSize: 22,
              color: C.purpleLift,
              border: `1px solid ${C.purpleEdge}`,
              borderRadius: 999,
              padding: "6px 20px",
            }}
          >
            改图
          </div>
        </div>

        {/* 用户指令 */}
        <div
          style={{
            marginTop: 30,
            alignSelf: "flex-end",
            justifySelf: "end",
            maxWidth: 560,
            fontFamily: FONT,
            fontSize: 27,
            color: C.text,
            lineHeight: 1.5,
            padding: "18px 26px",
            borderRadius: "22px 22px 6px 22px",
            background: "linear-gradient(140deg, rgba(34,211,238,0.22), rgba(13,20,38,0.9))",
            border: `1px solid ${C.cyanEdge}`,
            marginLeft: "auto",
            ...userIn(0.7 * fps),
          }}
        >
          围绕简谐运动扩展一条进阶链
        </div>

        {/* 输入中 */}
        {typingVisible ? (
          <div
            style={{
              marginTop: 22,
              display: "flex",
              gap: 10,
              padding: "18px 26px",
              width: 140,
              borderRadius: "22px 22px 22px 6px",
              background: "rgba(148,163,184,0.1)",
              opacity: typingOpacity,
            }}
          >
            {[0, 1, 2].map((d) => (
              <div
                key={d}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  backgroundColor: C.purpleLift,
                  translate: `0px ${
                    Math.sin((frame - 1.6 * fps) * 0.28 + d) * -7
                  }px`,
                }}
              />
            ))}
          </div>
        ) : null}

        {/* Φ 回复：操作预览清单 */}
        <div
          style={{
            marginTop: 22,
            ...userIn(2.5 * fps),
          }}
        >
          <div
            style={{
              fontFamily: FONT,
              fontSize: 26,
              color: C.muted,
              marginBottom: 14,
            }}
          >
            拟执行 3 条操作，请先预览：
          </div>
          {ops.map((op, i) => {
            const at = 3.0 * fps + i * 0.35 * fps;
            const o = interpolate(frame, [at, at + 0.4 * fps], [0, 1], {
              extrapolateRight: "clamp",
              extrapolateLeft: "clamp",
            });
            return (
              <div
                key={op.kind + op.arg}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  fontFamily: MONO,
                  fontSize: 24,
                  color: C.text,
                  padding: "12px 22px",
                  marginBottom: 10,
                  borderRadius: 14,
                  border: "1px dashed rgba(153,69,234,0.6)",
                  background: C.purpleWash,
                  opacity: o,
                }}
              >
                <span style={{ color: C.purpleLift }}>{op.kind}</span>
                <span style={{ color: C.muted }}>·</span>
                <span>{op.arg}</span>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 18, marginTop: 20, opacity: userIn(4.6 * fps).opacity }}>
            <div
              style={{
                fontFamily: FONT,
                fontSize: 26,
                color: C.muted,
                padding: "13px 40px",
                borderRadius: 999,
                border: `1px solid ${C.panelEdge}`,
              }}
            >
              取消
            </div>
            <div
              style={{
                fontFamily: FONT,
                fontSize: 26,
                color: "#fff",
                fontWeight: 700,
                padding: "13px 46px",
                borderRadius: 999,
                background: `rgba(153,69,234,${0.55 + applyGlow * 0.45})`,
                border: `1px solid ${C.purpleLift}`,
                boxShadow: `0 0 ${applyGlow * 34}px rgba(153,69,234,0.8)`,
                scale: `${1 + applyGlow * 0.05}`,
              }}
            >
              应用
            </div>
          </div>
        </div>
      </div>

      {/* 右：微缩画布 */}
      <div
        style={{
          position: "absolute",
          left: 1010,
          top: 196,
          width: 800,
          height: 664,
          borderRadius: 30,
          border: `1px solid ${C.panelEdge}`,
          background: "rgba(10,16,32,0.86)",
          boxShadow: "0 24px 60px rgba(2,6,17,0.55)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: 24,
            color: C.faint,
            letterSpacing: 2,
            textAlign: "center",
            paddingTop: 24,
          }}
        >
          画布预览
        </div>
        <svg
          width={800}
          height={664}
          style={{ position: "absolute", left: 0, top: 0 }}
        >
          {previewNodes.map((n) => {
            const cx = n.x - 1010 + 150;
            return (
              <path
                key={n.title}
                d={`M 500 618 Q 500 430 ${cx} 272`}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={Math.min(edgeIn + edgeOut, 1)}
                stroke={C.purpleLift}
                strokeWidth={3}
                fill="none"
                opacity={0.8}
              />
            );
          })}
        </svg>

        {/* 基础节点 */}
        <div
          style={{
            position: "absolute",
            left: 500 - 160,
            top: 640 - 60,
            width: 320,
            padding: "20px 16px",
            borderRadius: 20,
            border: `1px solid ${C.purpleEdge}`,
            background: "linear-gradient(150deg, rgba(153,69,234,0.3), rgba(13,20,38,0.94))",
            textAlign: "center",
            fontFamily: FONT,
            fontSize: 28,
            fontWeight: 700,
            color: C.text,
          }}
        >
          什么是简谐运动
        </div>

        {/* 预览/应用节点 */}
        {previewNodes.map((n) => {
          const solid = 0.35 + applyPop * 0.65;
          const scale = 1 - undoOut;
          return (
            <div
              key={n.title}
              style={{
                position: "absolute",
                left: n.x - 1010,
                top: n.y,
                width: 300,
                padding: "20px 16px",
                borderRadius: 20,
                border: `${applyPop > 0.6 ? 1 : 2}px ${
                  applyPop > 0.6 ? "solid" : "dashed"
                } ${C.purpleLift}`,
                background:
                  "linear-gradient(150deg, rgba(153,69,234,0.3), rgba(13,20,38,0.94))",
                textAlign: "center",
                fontFamily: FONT,
                fontSize: 26,
                fontWeight: 700,
                color: C.text,
                opacity: previewIn * solid,
                scale: `${scale}`,
                transformOrigin: "center",
                boxShadow:
                  applyPop > 0.6 ? "0 0 34px rgba(153,69,234,0.45)" : "none",
              }}
            >
              {n.title}
            </div>
          );
        })}

        {/* 撤销消息与结果 */}
        <div
          style={{
            position: "absolute",
            left: 260,
            top: 92,
            fontFamily: FONT,
            fontSize: 24,
            color: C.text,
            padding: "10px 24px",
            borderRadius: 999,
            border: `1px solid ${C.cyanEdge}`,
            background: "rgba(34,211,238,0.14)",
            opacity: undoMsgIn,
          }}
        >
          用户：撤销
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 150,
            textAlign: "center",
            fontFamily: FONT,
            fontSize: 24,
            color: C.green,
            letterSpacing: 2,
            opacity: rolledIn,
          }}
        >
          已回滚到操作前（逆操作回滚，永远成功）
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 52,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: FONT,
          fontSize: 30,
          color: C.muted,
          letterSpacing: 3,
          opacity: captionIn,
        }}
      >
        先预览 · 后应用 · 一句话撤销 · 目标歧义主动反问
      </div>
    </div>
  );
};
