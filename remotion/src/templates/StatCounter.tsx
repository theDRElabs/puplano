import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { useStyle } from "../style";
const { fontFamily: inter } = loadFont("normal", { weights: ["400", "700", "800"], subsets: ["latin"] });

type Props = { value: number; from?: number; prefix?: string; suffix?: string; decimals?: number; label: string; layout: number };

export const StatCounter: React.FC<Props> = ({ value, from = 0, prefix = "", suffix = "", decimals = 0, label, layout }) => {
  const { palette, typography } = useStyle();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const grow = spring({ frame, fps, durationInFrames: 60, config: { damping: 200 } });
  const text = prefix + Number((from + (value - from) * grow).toFixed(decimals)).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const labelIn = interpolate(frame, [40, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const align = layout === 2 ? "flex-start" : "center";
  const vertical = layout === 3 ? "flex-end" : "center";
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, justifyContent: vertical, alignItems: align, padding: 120, opacity: fadeOut, fontFamily: `${typography.displayFont}, ${inter}` }}>
      {layout === 2 && <div style={{ width: 120, height: 8, backgroundColor: palette.accent, marginBottom: 40 }} />}
      <div style={{ fontSize: 220, fontWeight: 800, color: palette.foreground, fontVariantNumeric: "tabular-nums" }}>{text}</div>
      <div style={{ marginTop: 24, fontSize: 48, color: palette.muted, opacity: labelIn, fontFamily: `${typography.bodyFont}, ${inter}` }}>{label}</div>
      {layout === 3 && <div style={{ marginTop: 40, height: 8, width: 1680 * grow, backgroundColor: palette.accent }} />}
    </AbsoluteFill>
  );
};
