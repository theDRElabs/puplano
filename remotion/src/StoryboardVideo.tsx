import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { renderTemplate, Scene } from "./adapter";

type Overlay = {
  id: string;
  kind: string;
  text: string;
  position?: string;
  startMs: number;
  endMs: number;
};

export type StoryboardProps = {
  title: string;
  durationMs: number;
  scenes: Scene[];
  overlays: Overlay[];
};

const Transition: React.FC<{ type?: string; durationMs?: number; children: React.ReactNode }> = ({ type, durationMs = 0, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const d = Math.max(1, Math.round((durationMs * fps) / 1000));
  const t = type && type !== "cut" ? interpolate(frame, [0, d], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const ease = 1 - Math.pow(1 - t, 3);
  const style: React.CSSProperties = {};
  if (type === "fade") style.opacity = t;
  if (type === "slide_left") style.transform = `translateX(${(1 - ease) * 100}%)`;
  if (type === "slide_up") style.transform = `translateY(${(1 - ease) * 100}%)`;
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};

const OverlayItem: React.FC<{ o: Overlay }> = ({ o }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const top = o.position === "top";
  const box: React.CSSProperties = {
    fontFamily: "Inter, sans-serif",
    color: "#ffffff",
    fontSize: 32,
    maxWidth: 1500,
  };
  if (o.kind === "source_caption") { box.fontSize = 26; box.color = "#9fb3c8"; }
  if (o.kind === "lower_third") { box.fontSize = 42; box.fontWeight = 600; box.padding = "16px 28px"; box.background = "rgba(11,18,32,0.78)"; box.borderLeft = "6px solid #4da3ff"; }
  if (o.kind === "label") { box.fontSize = 30; box.fontWeight = 700; box.padding = "8px 24px"; box.borderRadius = 999; box.background = "#4da3ff"; box.color = "#0b1220"; }
  return (
    <AbsoluteFill style={{ opacity: fade, padding: top ? "60px 80px 0" : "0 80px 60px", justifyContent: top ? "flex-start" : "flex-end", alignItems: "flex-start" }}>
      <div style={box}>{o.text}</div>
    </AbsoluteFill>
  );
};

export const StoryboardVideo: React.FC<StoryboardProps> = ({ scenes, overlays = [] }) => {
  const { fps } = useVideoConfig();
  const f = (ms: number) => Math.round((ms * fps) / 1000);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b1220" }}>
      {scenes.map((s) => (
        <Sequence key={s.id} from={f(s.startMs)} durationInFrames={Math.max(1, f(s.endMs) - f(s.startMs))}>
          <Transition type={s.transitionIn?.type} durationMs={s.transitionIn?.durationMs}>
            {renderTemplate(s)}
          </Transition>
        </Sequence>
      ))}
      {overlays.map((o) => (
        <Sequence key={o.id} from={f(o.startMs)} durationInFrames={Math.max(1, f(o.endMs) - f(o.startMs))}>
          <OverlayItem o={o} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
