import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
const { fontFamily: inter } = loadFont("normal", { weights: ["400", "700", "800"], subsets: ["latin"] });

type Props = { image: string; caption?: string; source?: string; layout: number };

export const ImageZoom: React.FC<Props> = ({ image, caption, source, layout }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const capIn = interpolate(frame, [20, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const src = image.startsWith("http") ? image : staticFile(image);
  const scale = layout === 2 ? 1.15 : 1 + 0.12 * t;
  const tx = layout === 2 ? (0.5 - t) * 8 : 0;
  const photo = <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `translateX(${tx}%) scale(${scale})` }} />;
  const cap = (
    <div style={{ opacity: capIn }}>
      {caption && <div style={{ color: "white", fontSize: 56, fontWeight: 800, lineHeight: 1.2 }}>{caption}</div>}
      {source && <div style={{ color: "#9fb3c8", fontSize: 30, marginTop: 16 }}>Source: {source}</div>}
    </div>
  );
  if (layout === 3) {
    return (
      <AbsoluteFill style={{ backgroundColor: "#0b1220", padding: 120, flexDirection: "row", alignItems: "center", gap: 80, opacity: fadeIn * fadeOut, fontFamily: inter }}>
        <div style={{ width: 1000, height: 640, borderRadius: 24, overflow: "hidden", flexShrink: 0 }}>{photo}</div>
        <div style={{ flex: 1 }}>{cap}</div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b1220", opacity: fadeIn * fadeOut, fontFamily: inter }}>
      <AbsoluteFill style={{ overflow: "hidden" }}>{photo}</AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(11,18,32,0.9) 0%, rgba(11,18,32,0) 45%)" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", padding: 120 }}>{cap}</AbsoluteFill>
    </AbsoluteFill>
  );
};
