import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import world from "world-atlas/countries-50m.json";
import { loadFont } from "@remotion/google-fonts/Inter";
import { rgba, useStyle } from "../style";
const { fontFamily: inter } = loadFont("normal", { weights: ["400", "700", "800"], subsets: ["latin"] });

type Pin = { name: string; lon: number; lat: number };
type Props = { title: string; highlight: string[]; pins: Pin[]; layout: number; bounds?: [number, number, number, number] };

const countries: any = feature(world as any, (world as any).objects.countries);
countries.features = countries.features.filter((f: any) => f.properties.name !== "Antarctica");

export const MapScene: React.FC<Props> = ({ title, highlight, pins, layout, bounds }) => {
  const { palette, typography } = useStyle();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const W = 1680, H = 760;
  const show = (i: number) => spring({ frame: frame - 20 - i * 14, fps, durationInFrames: 30, config: { damping: 200 } });
  const proj = geoNaturalEarth1();
  if (bounds) {
    proj.fitExtent([[0, 0], [W, H]], { type: "MultiPoint", coordinates: [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]] } as any);
  } else if (layout === 2 && pins.length > 0) {
    const lons = pins.map((p) => p.lon), lats = pins.map((p) => p.lat);
    const pad = 12;
    const x0 = Math.min(...lons) - pad, x1 = Math.max(...lons) + pad;
    const y0 = Math.max(-85, Math.min(...lats) - pad), y1 = Math.min(85, Math.max(...lats) + pad);
    proj.fitExtent([[0, 0], [W, H]], { type: "MultiPoint", coordinates: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] } as any);
  } else {
    proj.fitExtent([[0, 0], [W, H]], countries as any);
  }
  const path = geoPath(proj);
  const xy = pins.map((p) => proj([p.lon, p.lat]) as [number, number]);
  const route = pins.length > 1 ? path({ type: "LineString", coordinates: pins.map((p) => [p.lon, p.lat]) } as any) : null;
  const draw = interpolate(frame, [20, 20 + pins.length * 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const landColor = rgba(palette.muted, 0.35);
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, padding: 120, opacity: fadeOut, fontFamily: `${typography.displayFont}, ${inter}` }}>
      <div style={{ color: palette.foreground, fontSize: 64, fontWeight: 800 }}>{title}</div>
      <svg width={W} height={H} style={{ marginTop: 20 }}>
        <defs><radialGradient id="vig" cx="50%" cy="50%" r="55%"><stop offset="55%" stopColor={palette.background} stopOpacity="0" /><stop offset="90%" stopColor={palette.background} stopOpacity="1" /></radialGradient></defs>
        {countries.features.map((f: any, i: number) => (
          <path key={i} d={path(f) || ""} fill={highlight.includes(f.properties.name) ? palette.accent : landColor} stroke={palette.background} strokeWidth={1} />
        ))}
        {layout === 2 && <rect width={W} height={H} fill="url(#vig)" />}
        {layout === 3 && route && (
          <path d={route} fill="none" stroke={palette.foreground} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
        )}
        {pins.map((p, i) => (
          <g key={i} opacity={show(i)}>
            <circle cx={xy[i][0]} cy={xy[i][1]} r={14} fill={palette.foreground} stroke={palette.accent} strokeWidth={6} />
            <text x={xy[i][0]} y={xy[i][1] - 30} fill={palette.foreground} fontSize={40} fontWeight={700} fontFamily={`${typography.bodyFont}, ${inter}`} textAnchor="middle" stroke={palette.background} strokeWidth={8} paintOrder="stroke" strokeLinejoin="round">{p.name}</text>
          </g>
        ))}
      </svg>
    </AbsoluteFill>
  );
};
