import React from "react";
import {
  AbsoluteFill,
  Html5Audio,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";
import type {
  AudioClip,
  AudioTrack,
  OverlayClip,
  OverlayTrack,
  Timeline,
  VideoClip,
  VideoTrack,
} from "../../schemas/timeline";
import { renderTemplate } from "./adapter";
import {
  OverlayItem,
  Transition,
  captionStyleFor,
  type WordTiming,
} from "./StoryboardVideo";
import { StyleProvider, useStyle, type StyleProfile } from "./style";
import { WordCaptions } from "./WordCaptions";
import { clipFrames, msToFrame } from "./timeline-timing";

export type TimelineVideoProps = {
  timeline: Timeline;
  words?: WordTiming[];
  style?: StyleProfile;
};

const mediaSource = (file: string) =>
  /^https?:\/\//i.test(file) ? file : staticFile(file);

const programTrack = (timeline: Timeline): VideoTrack => {
  const tracks = timeline.tracks.filter(
    (track): track is VideoTrack =>
      track.kind === "video" && track.role === "program",
  );
  if (tracks.length !== 1) {
    throw new Error(
      `TimelineVideo needs exactly one program video track, found ${tracks.length}`,
    );
  }
  return tracks[0];
};

const VideoLayer: React.FC<{ track: VideoTrack }> = ({ track }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {track.clips.map((clip: VideoClip) => {
        const { from, durationInFrames } = clipFrames(
          clip.startMs,
          clip.endMs,
          fps,
        );
        return (
          <Sequence
            key={clip.id}
            name={`${track.id}:${clip.id}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <Transition
              type={clip.transitionIn?.type}
              durationMs={clip.transitionIn?.durationMs}
            >
              {renderTemplate(clip)}
            </Transition>
          </Sequence>
        );
      })}
    </>
  );
};

const OverlayLayer: React.FC<{ track: OverlayTrack }> = ({ track }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {track.clips.map((clip: OverlayClip) => {
        const { from, durationInFrames } = clipFrames(
          clip.startMs,
          clip.endMs,
          fps,
        );
        return (
          <Sequence
            key={clip.id}
            name={`${track.id}:${clip.id}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <OverlayItem o={clip} />
          </Sequence>
        );
      })}
    </>
  );
};

type NarrationWindow = { startMs: number; endMs: number };

const narrationWindows = (timeline: Timeline): NarrationWindow[] =>
  timeline.tracks
    .filter((track): track is AudioTrack => track.kind === "audio")
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === "narration")
    .map((clip) => ({ startMs: clip.startMs, endMs: clip.endMs }));

const AudioLayer: React.FC<{
  track: AudioTrack;
  narration: NarrationWindow[];
}> = ({ track, narration }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {track.clips.map((clip: AudioClip) => {
        const { from, durationInFrames } = clipFrames(
          clip.startMs,
          clip.endMs,
          fps,
        );
        const trimBefore = msToFrame(clip.sourceInMs, fps);
        const sourceDuration = Math.max(
          1,
          msToFrame(clip.sourceOutMs, fps) - trimBefore,
        );
        const clipDurationMs = clip.endMs - clip.startMs;

        // Volume is evaluated on the clip-relative frame, matching the
        // Sequence the audio lives in.
        const volume = (frame: number): number => {
          const elapsedMs = (frame * 1000) / fps;
          const timelineMs = clip.startMs + elapsedMs;
          const ducked =
            clip.kind === "music" &&
            clip.ducking?.whenNarration === true &&
            narration.some(
              (window) =>
                timelineMs >= window.startMs && timelineMs <= window.endMs,
            );
          const level = ducked ? clip.ducking!.gain : clip.gain;
          const fadeIn = clip.fade?.inMs
            ? Math.min(1, elapsedMs / clip.fade.inMs)
            : 1;
          const remainingMs = Math.max(0, clipDurationMs - elapsedMs);
          const fadeOut = clip.fade?.outMs
            ? Math.min(1, remainingMs / clip.fade.outMs)
            : 1;
          return Math.max(0, Math.min(1, level * Math.min(fadeIn, fadeOut)));
        };

        return (
          <Sequence
            key={clip.id}
            name={`${track.id}:${clip.id}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <Html5Audio
              name={`${track.id}:${clip.id}`}
              src={mediaSource(clip.file)}
              trimBefore={trimBefore}
              durationInFrames={sourceDuration}
              volume={volume}
            />
          </Sequence>
        );
      })}
    </>
  );
};

const TimelineVideoBody: React.FC<TimelineVideoProps> = ({
  timeline,
  words = [],
}) => {
  const style = useStyle();
  const program = programTrack(timeline);
  const broll = timeline.tracks.filter(
    (track): track is VideoTrack =>
      track.kind === "video" && track.role === "broll",
  );
  const overlays = timeline.tracks.filter(
    (track): track is OverlayTrack => track.kind === "overlay",
  );
  const audio = timeline.tracks.filter(
    (track): track is AudioTrack => track.kind === "audio",
  );
  const narration = narrationWindows(timeline);

  return (
    <AbsoluteFill style={{ backgroundColor: style.palette.background }}>
      <VideoLayer track={program} />
      {broll.map((track) => (
        <VideoLayer key={track.id} track={track} />
      ))}
      {overlays.map((track) => (
        <OverlayLayer key={track.id} track={track} />
      ))}
      {words.length > 0 && (
        <WordCaptions
          words={words}
          maxWords={style.captions.maxWords}
          maxMs={style.captions.maxMs}
          captionStyle={captionStyleFor(style)}
        />
      )}
      {audio.map((track) => (
        <AudioLayer key={track.id} track={track} narration={narration} />
      ))}
    </AbsoluteFill>
  );
};

export const TimelineVideo: React.FC<TimelineVideoProps> = (props) => (
  <StyleProvider style={props.style}>
    <TimelineVideoBody {...props} />
  </StyleProvider>
);
