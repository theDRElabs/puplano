import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { useStyle } from "../style";
const { fontFamily: inter } = loadFont("normal", { weights: ["400", "700", "800"], subsets: ["latin"] });

type Item = { label: string; value: number };
type Props = { title: string; data: Item[]; unit?: string; layout: number };

const CUR = ["$", "€", "£", "¥"];
const fmt = (v: number, unit: string) => {
  const n = v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (CUR.includes(unit)) return unit + n;
  return /^[A-Za-z]/.test(unit) ? n + " " + unit : n + unit;
};

export const Chart: React.FC<Props> = ({ title, data, unit = "", layout }) => {
  const { palette, typography } = useStyle();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const max = Math.max(...data.map((d) => d.value));
  const grow = (i: number) => spring({ frame: frame - 15 - i * 6, fps, durationInFrames: 40, config: { damping: 200 } });
  const W = 1680, H = 620;
  const label = { color: palette.muted, fontSize: 36, fontFamily: `${typography.bodyFont}, ${inter}` };
  const n = Math.max(1, data.length - 1);
  const pts = data.map((d, i) => [(i / n) * W, H - (d.value / max) * (H - 80)]);
  const path = pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
  const draw = interpolate(frame, [15, 75], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, padding: 120, opacity: fadeOut, fontFamily: `${typography.displayFont}, ${inter}` }}>
      <div style={{ color: palette.foreground, fontSize: 64, fontWeight: 800, marginBottom: 60 }}>{title}</div>
      {layout === 1 && (
        <div style={{ display: "flex", alignItems: "flex-end", gap: 40, height: H, width: W }}>
          {data.map((d, i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }}>
              <div style={{ color: palette.foreground, fontSize: 44, fontWeight: 700, marginBottom: 12, opacity: grow(i) }}>{fmt(d.value, unit)}</div>
              <div style={{ width: "100%", height: (d.value / max) * (H - 160) * grow(i), backgroundColor: palette.accent, borderRadius: 8 }} />
              <div style={{ ...label, marginTop: 16 }}>{d.label}</div>
            </div>
          ))}
        </div>
      )}
      {layout === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 56, width: W }}>
          {data.map((d, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 28 }}>
              <div style={{ ...label, width: 260 }}>{d.label}</div>
              <div style={{ flex: 1 }}>
                <div style={{ height: 88, width: `${(d.value / max) * 100 * grow(i)}%`, backgroundColor: palette.accent, borderRadius: 8 }} />
              </div>
              <div style={{ color: palette.foreground, fontSize: 44, fontWeight: 700, width: 200, opacity: grow(i) }}>{fmt(d.value, unit)}</div>
            </div>
          ))}
        </div>
      )}
      {layout === 3 && (
        <div>
          <svg width={W} height={H} style={{ overflow: "visible" }}>
            <path d={path} fill="none" stroke={palette.accent} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
            {pts.map((p, i) => (
              <g key={i} opacity={draw * (data.length - 1) >= i ? 1 : 0}><circle cx={p[0]} cy={p[1]} r={14} fill={palette.foreground} /><text x={p[0]} y={p[1] - 32} fill={palette.foreground} fontSize={40} fontWeight={700} fontFamily={`${typography.bodyFont}, ${inter}`} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}>{fmt(data[i].value, unit)}</text></g>
            ))}
          </svg>
          <div style={{ display: "flex", justifyContent: "space-between", width: W, marginTop: 24 }}>
            {data.map((d, i) => (<div key={i} style={label}>{d.label}</div>))}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
