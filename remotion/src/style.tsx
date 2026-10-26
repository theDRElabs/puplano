import React, { createContext, useContext } from "react";
import type { StyleProfile } from "../../schemas/style";

export type { StyleProfile };

export const DEFAULT_STYLE: StyleProfile = {
  id: "network-truecrime",
  label: "Network True Crime",
  video: { fps: 30, width: 1920, height: 1080, safeAreaPct: 5 },
  palette: {
    background: "#0c0a09",
    foreground: "#f2ece6",
    accent: "#c9a227",
    muted: "#7a6f66",
  },
  typography: {
    displayFont: "Inter",
    bodyFont: "Inter",
    captionFont: "Inter",
    captionSizePx: 34,
    captionColor: "#f2ece6",
    captionBackground: "#000000",
    captionBackgroundOpacity: 0.55,
    labelColor: "#ffffff",
    labelBackground: "#000000",
    labelBackgroundOpacity: 0.45,
    labelPosition: "lower_left",
  },
  grade: {
    meanRgb: [96, 83, 77],
    medianLuma: 79,
    saturation: 0.24,
    grain: 0.06,
    vignette: 0.18,
  },
  pacing: {
    wpmSpoken: 152,
    wpmTotal: 134,
    silenceRatio: 0.12,
    pausesPerMinute: 11,
    pauseMedianMs: 530,
    pauseP90Ms: 1140,
    sentenceMinMs: 500,
    sentenceMaxMs: 900,
    beatMs: [2500, 4500],
    cutsPerMinute: 12,
    medianShotMs: 3700,
    minShotMs: 1600,
    longShotShare: 0.27,
    cutOnSentenceEnd: 0.65,
    holdsUpToMs: 42000,
    curve: ["open_high", "mid_ease", "climax_accel", "resolve_hold"],
  },
  captions: {
    maxWords: 7,
    maxMs: 3500,
    position: "bottom",
    nameLabel: true,
  },
};

const StyleContext = createContext<StyleProfile>(DEFAULT_STYLE);

export const StyleProvider: React.FC<{
  style?: StyleProfile | null;
  children: React.ReactNode;
}> = ({ style, children }) => (
  <StyleContext.Provider value={style ?? DEFAULT_STYLE}>
    {children}
  </StyleContext.Provider>
);

export const useStyle = (): StyleProfile => useContext(StyleContext);

export const hexToRgb = (hex: string): [number, number, number] => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [0, 0, 0];
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

export const rgba = (hex: string, alpha: number): string => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
