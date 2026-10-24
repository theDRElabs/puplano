import React from "react";
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily: inter } = loadFont("normal", {
  weights: ["400", "700", "800"],
  subsets: ["latin"],
});

type Props = {
  video: string;
  caption?: string;
  source?: string;
  startFromMs?: number;
  layout: number;
};

const sourceFor = (file: string) =>
  /^https?:\/\//i.test(file) ? file : staticFile(file);

export const VideoClip: React.FC<Props> = ({
  video,
  caption,
  source,
  startFromMs = 0,
  layout,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 10], [0, 1], {
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 10, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp" },
  );
  const captionIn = interpolate(frame, [12, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const trimBefore = Math.round((startFromMs * fps) / 1000);

  const footage = (
    <OffthreadVideo
      src={sourceFor(video)}
      trimBefore={trimBefore}
      muted
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        filter: "saturate(0.68) contrast(1.08) brightness(0.78)",
      }}
    />
  );

  const copy = (align: "left" | "center" = "left") => (
    <div style={{ opacity: captionIn, textAlign: align }}>
      {caption && (
        <div
          style={{
            color: "white",
            fontSize: 58,
            fontWeight: 800,
            lineHeight: 1.15,
          }}
        >
          {caption}
        </div>
      )}
      {source && (
        <div style={{ color: "#9fb3c8", fontSize: 26, marginTop: 18 }}>
          {source}
        </div>
      )}
    </div>
  );

  if (layout === 2) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "#0b1220",
          padding: 120,
          flexDirection: "row",
          alignItems: "center",
          gap: 80,
          opacity: fadeIn * fadeOut,
          fontFamily: inter,
        }}
      >
        <div
          style={{
            width: 1080,
            height: 720,
            borderRadius: 24,
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {footage}
        </div>
        <div style={{ flex: 1 }}>{copy()}</div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b1220",
        opacity: fadeIn * fadeOut,
        fontFamily: inter,
      }}
    >
      <AbsoluteFill style={{ overflow: "hidden" }}>{footage}</AbsoluteFill>
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at center, transparent 35%, rgba(11,18,32,0.7) 100%), linear-gradient(to top, rgba(11,18,32,0.92) 0%, transparent 55%)",
        }}
      />
      {(caption || source) && (
        <AbsoluteFill
          style={{
            justifyContent: layout === 3 ? "center" : "flex-end",
            alignItems: layout === 3 ? "center" : "flex-start",
            padding: 120,
          }}
        >
          <div style={{ maxWidth: layout === 3 ? 1300 : 1500 }}>
            {copy(layout === 3 ? "center" : "left")}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
