import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { rgba, useStyle } from "../style";
const { fontFamily: inter } = loadFont("normal", { weights: ["400", "700", "800"], subsets: ["latin"] });

type Props = { quote: string; author: string; role?: string; image?: string; highlight?: string; layout: number };

export const QuoteCutout: React.FC<Props> = ({ quote, author, role, image, highlight, layout }) => {
  const { palette, typography } = useStyle();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const inQ = spring({ frame: frame - 10, fps, durationInFrames: 40, config: { damping: 200 } });
  const inA = interpolate(frame, [45, 65], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const inP = spring({ frame, fps, durationInFrames: 40, config: { damping: 200 } });
  const parts = highlight ? quote.split(highlight) : [quote];
  const qText = parts.map((p, i) => (<React.Fragment key={i}>{p}{i < parts.length - 1 && <span style={{ color: palette.accent }}>{highlight}</span>}</React.Fragment>));
  const size = layout === 1 ? 140 : layout === 2 ? 440 : 520;
  const radius = layout === 2 ? 24 : size / 2;
  const src = image ? (image.startsWith("http") ? image : staticFile(image)) : null;
  const portrait = (
    <div style={{ width: size, height: layout === 2 ? 560 : size, borderRadius: radius, overflow: "hidden", backgroundColor: rgba(palette.muted, 0.35), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, opacity: inP, transform: `scale(${0.92 + 0.08 * inP})` }}>
      {src ? <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ color: palette.accent, fontSize: size / 2, fontWeight: 800 }}>{author.charAt(0)}</div>}
    </div>
  );
  const textBlock = (
    <div style={{ opacity: inQ, transform: `translateY(${(1 - inQ) * 24}px)` }}>
      <div style={{ color: palette.foreground, fontSize: 60, fontWeight: 800, lineHeight: 1.25, textAlign: layout === 1 ? "center" : "left" }}>“{qText}”</div>
      <div style={{ marginTop: 40, opacity: inA, textAlign: layout === 1 ? "center" : "left" }}>
        <div style={{ color: palette.foreground, fontSize: 44, fontWeight: 700 }}>{author}</div>
        {role && <div style={{ color: palette.muted, fontSize: 36, marginTop: 8 }}>{role}</div>}
      </div>
    </div>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, padding: 120, opacity: fadeOut, fontFamily: `${typography.displayFont}, ${inter}`, flexDirection: layout === 1 ? "column" : "row", justifyContent: "center", alignItems: "center", gap: layout === 1 ? 56 : 100 }}>
      {layout === 3 ? <><div style={{ flex: 1 }}>{textBlock}</div>{portrait}</> : <>{portrait}<div style={{ flex: layout === 1 ? undefined : 1, maxWidth: layout === 1 ? 1500 : undefined }}>{textBlock}</div></>}
    </AbsoluteFill>
  );
};
