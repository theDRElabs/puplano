import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Storyboard } from "../schemas/storyboard";
import {
  Timeline,
  type AudioTrack,
  type OverlayTrack,
  type Timeline as TimelineType,
  type VideoClip,
  type VideoTrack,
} from "../schemas/timeline";
import { compileProjectTimeline } from "../scripts/compile-timeline";
import { remapTimelineAssets } from "../scripts/timeline-assets";
import {
  clipFrames,
  msToFrame,
  totalFrames,
} from "../remotion/src/timeline-timing";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (relative: string): any =>
  JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));

const sha = (fill: string): string => fill.repeat(64);

const programTrackOf = (timeline: TimelineType): VideoTrack => {
  const track = timeline.tracks.find(
    (candidate): candidate is VideoTrack =>
      candidate.kind === "video" && candidate.role === "program",
  );
  assert.ok(track, "timeline has one program video track");
  return track;
};

const brollTracksOf = (timeline: TimelineType): VideoTrack[] =>
  timeline.tracks.filter(
    (candidate): candidate is VideoTrack =>
      candidate.kind === "video" && candidate.role === "broll",
  );

const overlayTracksOf = (timeline: TimelineType): OverlayTrack[] =>
  timeline.tracks.filter(
    (candidate): candidate is OverlayTrack => candidate.kind === "overlay",
  );

const audioTracksOf = (timeline: TimelineType): AudioTrack[] =>
  timeline.tracks.filter(
    (candidate): candidate is AudioTrack => candidate.kind === "audio",
  );

const audioClipsOf = (timeline: TimelineType) =>
  audioTracksOf(timeline).flatMap((track) => track.clips);

const timingOf = (clip: VideoClip) => ({
  startMs: clip.startMs,
  endMs: clip.endMs,
  anchor: clip.anchor,
  holdMs: clip.holdMs,
  transitionIn: clip.transitionIn,
  effects: clip.effects,
});

const minimalStoryboard = (music: boolean) =>
  Storyboard.parse({
    title: "Test",
    audioFile: "voice/narration.mp3",
    durationMs: 2000,
    scenes: [
      {
        id: "s1",
        chapter: 1,
        template: "kinetic_title",
        layout: 1,
        startMs: 0,
        endMs: 1000,
        props: { text: "One" },
      },
      {
        id: "s2",
        chapter: 2,
        template: "kinetic_title",
        layout: 2,
        startMs: 1000,
        endMs: 2000,
        props: { text: "Two" },
      },
    ],
    overlays: [],
    ...(music
      ? {
          music: {
            file: "audio/music.mp3",
            baseVolume: 0.5,
            duckedVolume: 0.2,
            fadeMs: 100,
          },
        }
      : {}),
  });

const minimalTimeline = (music: boolean) => ({
  id: "test-timeline",
  title: "Test timeline",
  durationMs: 2000,
  fps: 30,
  width: 1920,
  height: 1080,
  tracks: [
    {
      kind: "video",
      id: "video-main",
      role: "program",
      clips: [
        {
          id: "s1",
          sceneId: "s1",
          template: "kinetic_title",
          layout: 1,
          props: { text: "source one" },
          startMs: 0,
          endMs: 1000,
        },
        {
          id: "s2",
          sceneId: "s2",
          template: "kinetic_title",
          layout: 2,
          props: { text: "source two" },
          startMs: 1000,
          endMs: 2000,
        },
      ],
    },
    {
      kind: "video",
      id: "video-broll",
      role: "broll",
      clips: [
        {
          id: "broll-s2",
          sceneId: "s2",
          template: "kinetic_title",
          layout: 3,
          props: { text: "source broll" },
          startMs: 200,
          endMs: 600,
          transitionIn: { type: "fade", durationMs: 200, overlapMs: 0 },
        },
      ],
    },
    {
      kind: "overlay",
      id: "overlay-main",
      clips: [
        {
          id: "label",
          kind: "label",
          text: "Test label",
          position: "top",
          startMs: 0,
          endMs: 2000,
        },
      ],
    },
    {
      kind: "audio",
      id: "audio-narration",
      clips: [
        {
          id: "narration",
          kind: "narration",
          file: "voice/narration.mp3",
          startMs: 0,
          endMs: 2000,
          sourceInMs: 0,
          sourceOutMs: 2000,
          gain: 1,
        },
      ],
    },
    ...(music
      ? [
          {
            kind: "audio",
            id: "audio-music",
            clips: [
              {
                id: "music",
                kind: "music",
                file: "audio/music.mp3",
                startMs: 0,
                endMs: 2000,
                sourceInMs: 0,
                sourceOutMs: 2000,
                gain: 0.5,
                ducking: { gain: 0.2, whenNarration: true },
                fade: { inMs: 100, outMs: 100 },
              },
            ],
          },
        ]
      : []),
  ],
  markers: [
    { atMs: 0, kind: "chapter", label: "Chapter 1", chapterId: "1" },
    { atMs: 1000, kind: "chapter", label: "Chapter 2", chapterId: "2" },
  ],
  metadata: {
    styleId: "network-truecrime",
    project: "test",
    sourceHashes: {
      script: sha("a"),
      words: sha("b"),
      storyboard: sha("c"),
    },
    compiler: { id: "puplano.compile-timeline", version: "1" },
    schemaVersion: 1,
  },
});

test("truecrime program clips map to the storyboard frames at 30fps", () => {
  const storyboard = Storyboard.parse(
    readJson("projects/truecrime/storyboard/storyboard.json"),
  );
  const timeline = compileProjectTimeline({ project: "truecrime" });
  const program = programTrackOf(timeline);

  assert.equal(program.clips.length, storyboard.scenes.length);
  assert.equal(program.role, "program");

  let cursor = 0;
  storyboard.scenes.forEach((scene, index) => {
    const clip = program.clips[index];
    assert.equal(clip.id, scene.id);
    assert.equal(clip.startMs, cursor);
    cursor = clip.endMs;

    assert.equal(
      clip.startMs === scene.startMs,
      true,
      `${clip.id}: start ms must match the storyboard`,
    );
    assert.equal(
      clip.endMs === scene.endMs,
      true,
      `${clip.id}: end ms must match the storyboard`,
    );
    assert.equal(msToFrame(clip.startMs, 30), msToFrame(scene.startMs, 30));
    assert.equal(msToFrame(clip.endMs, 30), msToFrame(scene.endMs, 30));
    assert.deepEqual(
      clipFrames(clip.startMs, clip.endMs, 30),
      clipFrames(scene.startMs, scene.endMs, 30),
    );
    assert.deepEqual(
      clipFrames(clip.startMs, clip.endMs, 30),
      {
        from: Math.round((scene.startMs * 30) / 1000),
        durationInFrames: Math.max(
          1,
          Math.round((scene.endMs * 30) / 1000) -
            Math.round((scene.startMs * 30) / 1000),
        ),
      },
    );
  });

  assert.equal(cursor, storyboard.durationMs);
  assert.equal(
    totalFrames(timeline.durationMs, timeline.fps),
    totalFrames(storyboard.durationMs, 30),
  );
  assert.equal(
    totalFrames(timeline.durationMs, timeline.fps),
    Math.max(1, Math.round((storyboard.durationMs * 30) / 1000)),
  );
});

test("remapping truecrime assets rewrites media paths without changing the EDL", () => {
  const source = Storyboard.parse(
    readJson("projects/truecrime/storyboard/storyboard.json"),
  );
  const staged = structuredClone(source);
  staged.audioFile = "generated/truecrime/voice/narration.mp3";
  for (const scene of staged.scenes) {
    if (scene.template === "video_clip") {
      scene.props.videoFile = `generated/truecrime/${scene.props.videoFile}`;
    }
  }

  const timeline = compileProjectTimeline({ project: "truecrime" });
  const remapped = remapTimelineAssets(timeline, source, staged);
  const program = programTrackOf(remapped);

  assert.equal(program.clips.length, programTrackOf(timeline).clips.length);
  for (const clip of program.clips) {
    const scene = staged.scenes.find(
      (candidate) => candidate.id === clip.sceneId,
    );
    assert.ok(scene, `staged scene ${clip.sceneId} exists`);
    assert.deepEqual(clip.props, scene.props);
    assert.deepEqual(timingOf(clip), timingOf(programTrackOf(timeline).clips.find((c) => c.id === clip.id)!));
  }

  const narration = audioClipsOf(remapped).find(
    (clip) => clip.kind === "narration",
  );
  assert.ok(narration);
  assert.equal(narration.file, staged.audioFile);

  assert.deepEqual(remapped.metadata, timeline.metadata);
  assert.deepEqual(remapped.markers, timeline.markers);
  assert.deepEqual(
    overlayTracksOf(remapped).map((track) => track.clips),
    overlayTracksOf(timeline).map((track) => track.clips),
  );
  assert.deepEqual(
    remapped.tracks.map((track) => [track.id, track.kind]),
    timeline.tracks.map((track) => [track.id, track.kind]),
  );
});

test("remapping handles broll, overlays, narration and music tracks", () => {
  const source = minimalStoryboard(true);
  const staged = structuredClone(source);
  staged.audioFile = "generated/test/voice/narration.mp3";
  staged.music!.file = "generated/test/audio/music.mp3";
  staged.scenes[0].props = { text: "staged one" } as any;
  staged.scenes[1].props = { text: "staged two" } as any;

  const timeline = Timeline.parse(minimalTimeline(true));
  const remapped = remapTimelineAssets(timeline, source, staged);

  const program = programTrackOf(remapped);
  assert.deepEqual(
    program.clips.map((clip) => clip.props),
    staged.scenes.map((scene) => scene.props),
  );
  program.clips.forEach((clip, index) => {
    assert.deepEqual(timingOf(clip), timingOf(programTrackOf(timeline).clips[index]));
  });

  const broll = brollTracksOf(remapped);
  assert.equal(broll.length, 1);
  assert.equal(broll[0].role, "broll");
  assert.equal(broll[0].clips[0].props.text, "staged two");
  assert.deepEqual(
    timingOf(broll[0].clips[0]),
    timingOf(brollTracksOf(timeline)[0].clips[0]),
  );

  assert.deepEqual(
    overlayTracksOf(remapped).map((track) => track.clips),
    overlayTracksOf(timeline).map((track) => track.clips),
  );

  const audio = audioClipsOf(remapped);
  assert.equal(
    audio.find((clip) => clip.kind === "narration")?.file,
    staged.audioFile,
  );
  const music = audio.find((clip) => clip.kind === "music");
  assert.ok(music);
  assert.equal(music.file, staged.music!.file);
  assert.deepEqual(music.ducking, { gain: 0.2, whenNarration: true });
  assert.deepEqual(music.fade, { inMs: 100, outMs: 100 });
  assert.equal(music.gain, 0.5);
  assert.deepEqual(remapped.metadata, timeline.metadata);
  assert.deepEqual(remapped.markers, timeline.markers);
});

test("music is dropped when optional staging omits it", () => {
  const source = minimalStoryboard(true);
  const staged = structuredClone(source);
  delete staged.music;
  staged.audioFile = "generated/test/voice/narration.mp3";

  const timeline = Timeline.parse(minimalTimeline(true));
  const remapped = remapTimelineAssets(timeline, source, staged);

  const audio = audioClipsOf(remapped);
  assert.equal(audio.some((clip) => clip.kind === "music"), false);
  assert.equal(audio.length, 1);
  assert.equal(audio[0].kind, "narration");
  assert.equal(audio[0].file, staged.audioFile);
  assert.deepEqual(
    remapped.tracks.filter((track) => track.kind === "audio").map((track) => track.id),
    ["audio-narration"],
  );
  assert.deepEqual(remapped.tracks.map((track) => track.id), [
    "video-main",
    "video-broll",
    "overlay-main",
    "audio-narration",
  ]);
});

test("remapping preserves a narration-only timeline", () => {
  const source = minimalStoryboard(false);
  const staged = structuredClone(source);
  staged.audioFile = "generated/test/voice/narration.mp3";

  const timeline = Timeline.parse(minimalTimeline(false));
  const remapped = remapTimelineAssets(timeline, source, staged);
  const audio = audioClipsOf(remapped);

  assert.equal(audio.length, 1);
  assert.equal(audio[0].kind, "narration");
  assert.equal(audio[0].file, staged.audioFile);
});
