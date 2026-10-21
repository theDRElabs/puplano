import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
const { fontFamily: inter } = loadFont("normal", { weights: ["400", "700", "800"], subsets: ["latin"] });

type Props = { text: string; subtext?: string; layout: number };

export const KineticTitle: React.FC<Props> = ({ text, subtext, layout }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const words = text.split(" ");

  // Three layouts: 1 = centred, 2 = left with an accent bar, 3 = low on the screen
  const align = layout === 2 ? "flex-start" : "center";
  const vertical = layout === 3 ? "flex-end" : "center";
  const textAlign = layout === 2 ? "left" : "center";

  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subtextIn = interpolate(frame, [words.length * 4 + 8, words.length * 4 + 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{ backgroundColor: "#0b1220", justifyContent: vertical, alignItems: align, padding: 120, opacity: fadeOut }}
    >
      {layout === 2 && <div style={{ width: 120, height: 8, backgroundColor: "#4da3ff", marginBottom: 40 }} />}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0 28px",
          justifyContent: align,
          textAlign,
          fontFamily: inter,
          fontWeight: 800,
          fontSize: 110,
          lineHeight: 1.1,
          color: "white",
        }}
      >
        {words.map((w, i) => {
          const p = spring({ frame: frame - i * 4, fps, config: { damping: 200 } });
          return (
            <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 40}px)` }}>
              {w}
            </span>
          );
        })}
      </div>
      {subtext && (
        <div style={{ marginTop: 36, fontSize: 42, color: "#9fb3c8", fontFamily: inter, opacity: subtextIn }}>
          {subtext}
        </div>
      )}
    </AbsoluteFill>
  );
};
