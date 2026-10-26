import React from "react";
import {
  AbsoluteFill,
  Html5Audio,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { renderTemplate, Scene } from "./adapter";
import { StyleProvider, rgba, useStyle, type StyleProfile } from "./style";
import { WordCaptions } from "./WordCaptions";

export type WordTiming = {
  word: string;
  startMs: number;
  endMs: number;
};

type Music = {
  file: string;
  baseVolume: number;
  duckedVolume: number;
  fadeMs: number;
};

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
  audioFile?: string;
  durationMs: number;
  scenes: Scene[];
  overlays: Overlay[];
  music?: Music;
  words?: WordTiming[];
  style?: StyleProfile;
};

const mediaSource = (file: string) =>
  /^https?:\/\//i.test(file) ? file : staticFile(file);

const narrationIsActive = (words: WordTiming[], timeMs: number): boolean => {
  let low = 0;
  let high = words.length - 1;
  let candidate = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (words[middle].startMs <= timeMs + 120) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return candidate >= 0 && words[candidate].endMs >= timeMs - 450;
};

const AudioTracks: React.FC<{
  audioFile?: string;
  durationMs: number;
  music?: Music;
  words: WordTiming[];
}> = ({ audioFile, durationMs, music, words }) => {
  const { fps } = useVideoConfig();

  const musicVolume = (frame: number): number => {
    if (!music) return 0;
    const timeMs = (frame * 1000) / fps;
    const narrating = words.length === 0 || narrationIsActive(words, timeMs);
    const level = narrating ? music.duckedVolume : music.baseVolume;
    if (music.fadeMs === 0) return level;

    const fadeIn = Math.min(1, timeMs / music.fadeMs);
    const fadeOut = Math.min(1, Math.max(0, durationMs - timeMs) / music.fadeMs);
    return level * Math.min(fadeIn, fadeOut);
  };

  return (
    <>
      {audioFile && (
        <Html5Audio name="Narration" src={mediaSource(audioFile)} />
      )}
      {music && (
        <Html5Audio
          name="Music"
          src={mediaSource(music.file)}
          loop
          loopVolumeCurveBehavior="extend"
          volume={musicVolume}
        />
      )}
    </>
  );
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
  const style = useStyle();
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const top = o.kind === "label" ? false : o.position === "top";
  const box: React.CSSProperties = {
    fontFamily: style.typography.bodyFont,
    color: style.palette.foreground,
    fontSize: 32,
    maxWidth: 1500,
  };
  if (o.kind === "source_caption") { box.fontSize = 26; box.color = style.palette.muted; }
  if (o.kind === "lower_third") {
    box.fontSize = 42;
    box.fontWeight = 600;
    box.padding = "16px 28px";
    box.background = rgba(style.palette.background, 0.78);
    box.borderLeft = `6px solid ${style.palette.accent}`;
  }
  if (o.kind === "label") {
    box.fontSize = 30;
    box.fontWeight = 700;
    box.padding = "8px 24px";
    box.borderRadius = 999;
    box.background = rgba(style.typography.labelBackground, style.typography.labelBackgroundOpacity);
    box.color = style.typography.labelColor;
  }
  return (
    <AbsoluteFill style={{ opacity: fade, padding: top ? "60px 80px 0" : "0 80px 60px", justifyContent: top ? "flex-start" : "flex-end", alignItems: "flex-start" }}>
      <div style={box}>{o.text}</div>
    </AbsoluteFill>
  );
};

const StoryboardVideoBody: React.FC<StoryboardProps> = ({
  audioFile,
  durationMs,
  scenes,
  overlays = [],
  music,
  words = [],
}) => {
  const style = useStyle();
  const { fps } = useVideoConfig();
  const f = (ms: number) => Math.round((ms * fps) / 1000);
  return (
    <AbsoluteFill style={{ backgroundColor: style.palette.background }}>
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
      {words.length > 0 && (
        <WordCaptions
          words={words}
          maxWords={style.captions.maxWords}
          maxMs={style.captions.maxMs}
          captionStyle={{
            size: style.typography.captionSizePx,
            color: style.typography.captionColor,
            background: style.typography.captionBackground,
            opacity: style.typography.captionBackgroundOpacity,
            position: style.captions.position,
            fontFamily: style.typography.captionFont,
            activeColor: style.palette.accent,
          }}
        />
      )}
      <AudioTracks
        audioFile={audioFile}
        durationMs={durationMs}
        music={music}
        words={words}
      />
    </AbsoluteFill>
  );
};

export const StoryboardVideo: React.FC<StoryboardProps> = (props) => (
  <StyleProvider style={props.style}>
    <StoryboardVideoBody {...props} />
  </StyleProvider>
);
