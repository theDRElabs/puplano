import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import type { WordTiming } from "./StoryboardVideo";

const { fontFamily: inter } = loadFont("normal", {
  weights: ["400", "700", "800"],
  subsets: ["latin"],
});

type CaptionCue = {
  startMs: number;
  endMs: number;
  words: WordTiming[];
};

export type CaptionStyle = {
  size: number;
  color: string;
  background: string;
  opacity: number;
  position: "bottom";
  fontFamily?: string;
  activeColor?: string;
};

export type CaptionOptions = {
  maxWords?: number;
  maxMs?: number;
};

const DEFAULT_MAX_WORDS = 7;
const DEFAULT_MAX_MS = 3500;

const endsSentence = (word: string) => /[.!?]["')\]]?$/.test(word);

const withOpacity = (color: string, opacity: number): string => {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
};

export const buildCaptionCues = (
  words: WordTiming[],
  options: CaptionOptions = {},
): CaptionCue[] => {
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const cues: CaptionCue[] = [];
  let current: WordTiming[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    cues.push({
      startMs: Math.max(0, first.startMs - 80),
      endMs: last.endMs + 220,
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    const shouldBreak =
      previous &&
      (current.length >= maxWords ||
        word.startMs - previous.endMs > 550 ||
        word.endMs - current[0].startMs > maxMs ||
        (current.length >= 3 && endsSentence(previous.word)));

    if (shouldBreak) flush();
    current.push(word);
  }
  flush();

  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].endMs = Math.min(cues[i].endMs, cues[i + 1].startMs);
  }
  return cues;
};

const findCue = (cues: CaptionCue[], timeMs: number): CaptionCue | undefined => {
  let low = 0;
  let high = cues.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle];
    if (timeMs < cue.startMs) high = middle - 1;
    else if (timeMs > cue.endMs) low = middle + 1;
    else return cue;
  }
  return undefined;
};

export const WordCaptions: React.FC<{
  words: WordTiming[];
  captionStyle?: CaptionStyle;
  maxWords?: number;
  maxMs?: number;
}> = ({ words, captionStyle, maxWords, maxMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = (frame * 1000) / fps;
  const cues = useMemo(
    () => buildCaptionCues(words, { maxWords, maxMs }),
    [words, maxWords, maxMs],
  );
  const cue = findCue(cues, timeMs);
  if (!cue) return null;

  let activeWord = -1;
  for (let i = 0; i < cue.words.length; i++) {
    if (timeMs >= cue.words[i].startMs) activeWord = i;
    else break;
  }

  const edge = Math.min(120, (cue.endMs - cue.startMs) / 3);
  const opacity = interpolate(
    timeMs,
    [cue.startMs, cue.startMs + edge, cue.endMs - edge, cue.endMs],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const style = captionStyle ?? {
    size: 38,
    color: "white",
    background: "rgba(5, 9, 16, 0.76)",
    opacity: 1,
    position: "bottom" as const,
    fontFamily: inter,
    activeColor: "rgb(77, 163, 255)",
  };

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        padding: "0 160px 112px",
        pointerEvents: "none",
        opacity,
        fontFamily: style.fontFamily ?? inter,
      }}
    >
      <div
        style={{
          maxWidth: 1380,
          padding: "16px 26px 18px",
          borderRadius: 12,
          backgroundColor: withOpacity(style.background, style.opacity),
          boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
          color: style.color,
          fontSize: style.size,
          fontWeight: 700,
          lineHeight: 1.25,
          textAlign: "center",
        }}
      >
        {cue.words.map((word, index) => (
          <span
            key={`${word.startMs}-${index}`}
            style={{
              color: index === activeWord ? (style.activeColor ?? style.color) : style.color,
              marginRight: index === cue.words.length - 1 ? 0 : "0.28em",
            }}
          >
            {word.word}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
