import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
const { fontFamily: inter } = loadFont("normal", { weights: ["400", "700", "800"], subsets: ["latin"] });

type Event = { date: string; label: string };
type Props = { title: string; events: Event[]; layout: number };

export const Timeline: React.FC<Props> = ({ title, events, layout }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const n = events.length;
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const show = (i: number) => spring({ frame: frame - 20 - i * 14, fps, durationInFrames: 30, config: { damping: 200 } });
  const line = interpolate(frame, [10, 20 + n * 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const date: React.CSSProperties = { color: "#4da3ff", fontSize: 44, fontWeight: 800 };
  const text: React.CSSProperties = { color: "white", fontSize: 40 };
  const W = 1680;
  const xs = events.map((_, i) => (n < 2 ? W / 2 : 180 + (i / (n - 1)) * (W - 360)));
  const box = (i: number): React.CSSProperties => ({ position: "absolute", left: xs[i] - 180, width: 360, textAlign: "center", opacity: show(i) });
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b1220", padding: 120, opacity: fadeOut, fontFamily: inter }}>
      <div style={{ color: "white", fontSize: 64, fontWeight: 800 }}>{title}</div>
      <div style={{ position: "relative", width: W, height: 700, marginTop: 40 }}>
      {layout !== 2 && (<>
        <div style={{ position: "absolute", left: 0, top: 347, height: 6, width: W * line, backgroundColor: "#4da3ff" }} />
        {events.map((e, i) => (<React.Fragment key={i}>
          <div style={{ position: "absolute", left: xs[i] - 14, top: 336, width: 28, height: 28, borderRadius: 14, backgroundColor: "white", opacity: show(i) }} />
          {layout === 1 ? (<>
            <div style={{ ...box(i), top: 250 }}><div style={date}>{e.date}</div></div>
            <div style={{ ...box(i), top: 400 }}><div style={text}>{e.label}</div></div>
          </>) : (
            <div style={{ ...box(i), top: i % 2 === 0 ? 150 : 400 }}><div style={date}>{e.date}</div><div style={text}>{e.label}</div></div>
          )}
        </React.Fragment>))}
      </>)}
      {layout === 2 && (<>
        <div style={{ position: "absolute", left: 351, top: 0, width: 6, height: 700 * line, backgroundColor: "#4da3ff" }} />
        {events.map((e, i) => {
          const y = i * (640 / Math.max(1, n - 1));
          return (
            <div key={i} style={{ position: "absolute", top: y, left: 0, display: "flex", alignItems: "center", opacity: show(i) }}>
              <div style={{ ...date, width: 300, textAlign: "right" }}>{e.date}</div>
              <div style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "white", margin: "0 40px" }} />
              <div style={text}>{e.label}</div>
            </div>
          );
        })}
      </>)}
      </div>
    </AbsoluteFill>
  );
};
