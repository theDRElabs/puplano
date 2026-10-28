import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  Timeline,
  type OverlayTrack,
  type VideoClip,
  type VideoTrack,
} from "../schemas/timeline";
import {
  assertTimelineCoverage,
  compileProjectTimeline,
} from "../scripts/compile-timeline";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (relative: string): any =>
  JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));

const sha = (fill: string): string => fill.repeat(64);

const tsxBin = (): string =>
  path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );

const minimalTimeline = (): any => ({
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
          template: "video_clip",
          layout: 1,
          props: {},
          startMs: 0,
          endMs: 1000,
        },
        {
          id: "s2",
          sceneId: "s2",
          template: "image_zoom",
          layout: 2,
          props: {},
          startMs: 1000,
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
  ],
  markers: [
    { atMs: 0, kind: "chapter", label: "Chapter 1", chapterId: "1" },
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

const videoTrackOf = (timeline: any): any => {
  const track = timeline.tracks.find(
    (candidate: any) => candidate.kind === "video",
  );
  assert.ok(track, "timeline has a video track");
  return track;
};

const narrationOf = (timeline: any): any => {
  const clip = timeline.tracks
    .filter((track: any) => track.kind === "audio")
    .flatMap((track: any) => track.clips)
    .find((candidate: any) => candidate.kind === "narration");
  assert.ok(clip, "timeline has a narration clip");
  return clip;
};

test("Timeline accepts a minimal EDL and rejects gaps, overlaps, and bad durations", () => {
  const valid = minimalTimeline();
  const result = Timeline.safeParse(valid);
  assert.equal(
    result.success,
    true,
    result.success ? "" : JSON.stringify(result.error.issues),
  );

  const gap = structuredClone(valid);
  gap.tracks[0].clips[1].startMs = 1100;
  const gapResult = Timeline.safeParse(gap);
  assert.equal(gapResult.success, false);
  if (!gapResult.success) {
    assert.ok(
      gapResult.error.issues.some((issue) => /gap|expected/.test(issue.message)),
      JSON.stringify(gapResult.error.issues),
    );
  }

  const overlap = structuredClone(valid);
  overlap.tracks[0].clips[1].startMs = 900;
  const overlapResult = Timeline.safeParse(overlap);
  assert.equal(overlapResult.success, false);
  if (!overlapResult.success) {
    assert.ok(
      overlapResult.error.issues.some((issue) =>
        /overlap|expected/.test(issue.message),
      ),
      JSON.stringify(overlapResult.error.issues),
    );
  }

  const badDuration = structuredClone(valid);
  badDuration.tracks[0].clips[1].endMs = 1000;
  assert.equal(Timeline.safeParse(badDuration).success, false);

  const noVideo = structuredClone(valid);
  noVideo.tracks = noVideo.tracks.filter(
    (track: any) => track.kind !== "video",
  );
  assert.equal(Timeline.safeParse(noVideo).success, false);

  const badFps = structuredClone(valid);
  badFps.fps = 25;
  assert.equal(Timeline.safeParse(badFps).success, false);
});

test("one program video track tiles while broll tracks may contain gaps", () => {
  const valid = minimalTimeline();
  valid.tracks.push({
    kind: "video",
    id: "video-broll",
    role: "broll",
    clips: [
      {
        id: "broll-a",
        sceneId: "broll-a",
        template: "video_clip",
        layout: 1,
        props: {},
        startMs: 500,
        endMs: 900,
      },
      {
        id: "broll-b",
        sceneId: "broll-b",
        template: "video_clip",
        layout: 1,
        props: {},
        startMs: 1400,
        endMs: 1800,
      },
    ],
  });

  const result = Timeline.safeParse(valid);
  assert.equal(
    result.success,
    true,
    result.success ? "" : JSON.stringify(result.error.issues),
  );
  if (!result.success) return;

  assert.doesNotThrow(() => assertTimelineCoverage(result.data));
  const broll = result.data.tracks.find(
    (track): track is VideoTrack =>
      track.kind === "video" && track.role === "broll",
  );
  assert.ok(broll);
  assert.equal(broll.clips.length, 2);

  // The broll track may also be contiguous; only the program track must tile.
  const contiguousBroll = structuredClone(result.data) as any;
  const brollTrack = contiguousBroll.tracks.find(
    (track: any) => track.kind === "video" && track.role === "broll",
  );
  brollTrack.clips[1].startMs = 900;
  assert.doesNotThrow(() => assertTimelineCoverage(contiguousBroll));
});

test("exactly one program video track is required", () => {
  const missing = minimalTimeline();
  missing.tracks[0].role = "broll";
  const missingResult = Timeline.safeParse(missing);
  assert.equal(missingResult.success, false);
  if (!missingResult.success) {
    assert.ok(
      missingResult.error.issues.some((issue) => /program/.test(issue.message)),
      JSON.stringify(missingResult.error.issues),
    );
  }
  assert.throws(() => assertTimelineCoverage(missing), /program/);

  const duplicate = minimalTimeline();
  duplicate.tracks.push({
    kind: "video",
    id: "video-main-2",
    role: "program",
    clips: [
      {
        id: "duplicate-program",
        sceneId: "duplicate-program",
        template: "video_clip",
        layout: 1,
        props: {},
        startMs: 0,
        endMs: 2000,
      },
    ],
  });
  const duplicateResult = Timeline.safeParse(duplicate);
  assert.equal(duplicateResult.success, false);
  if (!duplicateResult.success) {
    assert.ok(
      duplicateResult.error.issues.some((issue) =>
        /program/.test(issue.message),
      ),
      JSON.stringify(duplicateResult.error.issues),
    );
  }
  assert.throws(() => assertTimelineCoverage(duplicate), /program/);
});

test("compiler maps the truecrime storyboard to an EDL", () => {
  const storyboard = readJson("projects/truecrime/storyboard/storyboard.json");
  const timeline = compileProjectTimeline({ project: "truecrime" });
  const parsed = Timeline.safeParse(timeline);
  assert.equal(
    parsed.success,
    true,
    parsed.success ? "" : JSON.stringify(parsed.error.issues),
  );

  const video = timeline.tracks.find(
    (track): track is VideoTrack => track.kind === "video",
  );
  assert.ok(video);
  assert.equal(video.role, "program");
  assert.equal(video.clips.length, 11);
  assert.equal(video.clips.length, storyboard.scenes.length);

  const overlay = timeline.tracks.find(
    (track): track is OverlayTrack => track.kind === "overlay",
  );
  assert.ok(overlay);
  assert.equal(overlay.clips.length, 2);
  assert.deepEqual(
    overlay.clips.map((clip) => clip.id),
    storyboard.overlays.map((source: any) => source.id),
  );
  storyboard.overlays.forEach((source: any, index: number) => {
    const clip = overlay.clips[index];
    assert.equal(clip.kind, source.kind);
    assert.equal(clip.text, source.text);
    assert.equal(clip.position, source.position);
    assert.equal(clip.startMs, source.startMs);
    assert.equal(clip.endMs, source.endMs);
  });

  const narration = narrationOf(timeline);
  assert.equal(narration.file, storyboard.audioFile);
  assert.equal(narration.startMs, 0);
  assert.equal(narration.endMs, storyboard.durationMs);

  assert.equal(timeline.markers.length, 11);
  assert.ok(timeline.markers.every((marker) => marker.kind === "chapter"));
  assert.deepEqual(
    timeline.markers.map((marker) => marker.atMs),
    storyboard.scenes.map((scene: any) => scene.startMs),
  );
  assert.deepEqual(
    timeline.markers.map((marker) => marker.chapterId),
    storyboard.scenes.map((scene: any) => String(scene.chapter)),
  );

  assert.equal(timeline.metadata.styleId, "network-truecrime");
  assert.equal(timeline.metadata.project, "truecrime");
  assert.equal(timeline.metadata.schemaVersion, 1);
  for (const hash of Object.values(timeline.metadata.sourceHashes)) {
    assert.match(String(hash), /^[0-9a-f]{64}$/);
  }
});

test("compiled timeline covers the exact audio duration and preserves scene mapping", () => {
  const storyboard = readJson("projects/truecrime/storyboard/storyboard.json");
  const words = readJson("projects/truecrime/voice/words.json");
  const timeline = compileProjectTimeline({ project: "truecrime" });

  assert.equal(timeline.durationMs, words.durationMs);
  assert.equal(timeline.durationMs, storyboard.durationMs);
  assert.doesNotThrow(() => assertTimelineCoverage(timeline));

  const video = timeline.tracks.find(
    (track): track is VideoTrack => track.kind === "video",
  );
  assert.ok(video);

  let cursor = 0;
  for (const [index, scene] of storyboard.scenes.entries()) {
    const clip: VideoClip = video.clips[index];
    assert.equal(clip.id, scene.id);
    assert.equal(clip.sceneId, scene.id);
    assert.equal(clip.template, scene.template);
    assert.equal(clip.layout, scene.layout);
    assert.deepEqual(clip.anchor, scene.anchor);
    assert.equal(clip.holdMs, scene.holdMs);
    assert.equal(clip.startMs, cursor);
    cursor = clip.endMs;
    if (scene.transitionIn) {
      assert.ok(clip.transitionIn);
      assert.equal(clip.transitionIn.type, scene.transitionIn.type);
      assert.equal(clip.transitionIn.durationMs, scene.transitionIn.durationMs);
      assert.equal(clip.transitionIn.overlapMs, 0);
    } else {
      assert.equal(clip.transitionIn, undefined);
    }
  }
  assert.equal(cursor, words.durationMs);

  const narration = narrationOf(timeline);
  assert.equal(narration.endMs - narration.startMs, words.durationMs);
  assert.equal(
    narration.sourceOutMs - narration.sourceInMs,
    words.durationMs,
  );

  for (const track of timeline.tracks) {
    if (track.kind === "overlay" || track.kind === "audio") {
      for (const clip of track.clips) {
        assert.ok(clip.startMs >= 0);
        assert.ok(clip.endMs > clip.startMs);
        assert.ok(clip.endMs <= timeline.durationMs);
      }
    }
  }

  const broken = structuredClone(timeline) as any;
  videoTrackOf(broken).clips[1].startMs += 1;
  assert.throws(
    () => assertTimelineCoverage(broken),
    /gap|expected/,
  );
});

test("--dry-run prints a summary and writes nothing", () => {
  const out = path.join(tmpdir(), `puplano-timeline-dry-${process.pid}.json`);
  rmSync(out, { force: true });
  try {
    const stdout = execFileSync(
      tsxBin(),
      [
        "scripts/compile-timeline.ts",
        "truecrime",
        "--out",
        out,
        "--dry-run",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.match(stdout, /Dry run/i);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(out, { force: true });
  }
});

test("--style clean-explainer is accepted and reaches metadata", () => {
  const out = path.join(
    tmpdir(),
    `puplano-timeline-style-${process.pid}.json`,
  );
  rmSync(out, { force: true });
  try {
    const stdout = execFileSync(
      tsxBin(),
      [
        "scripts/compile-timeline.ts",
        "truecrime",
        "--style",
        "clean-explainer",
        "--out",
        out,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.match(stdout, /Wrote/);
    const timeline = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(timeline.metadata.styleId, "clean-explainer");
    assert.equal(timeline.fps, 30);
  } finally {
    rmSync(out, { force: true });
  }
});
