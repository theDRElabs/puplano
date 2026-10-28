import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Storyboard } from "../schemas/storyboard";
import type { Overlay } from "../schemas/storyboard";
import { WordTimings } from "../schemas/words";
import {
  Timeline as TimelineSchema,
  type AudioClip,
  type AudioTrack,
  type OverlayTrack,
  type Timeline,
  type VideoTrack,
} from "../schemas/timeline";
import { DEFAULT_STYLE_ID, loadStyle } from "./style";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPILER_ID = "puplano.compile-timeline";
const COMPILER_VERSION = "1";
const PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${path.relative(ROOT, file)}: ${message}`);
  }
};

const hashFile = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const formatIssues = (
  label: string,
  issues: Array<{ path: PropertyKey[]; message: string }>,
) => {
  const details = issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  return `${label} is invalid:\n${details}`;
};

const resolveOverlayTiming = (
  overlay: Overlay,
  storyboard: Storyboard,
  words: WordTimings,
): { startMs: number; endMs: number } => {
  if (overlay.startMs !== undefined && overlay.endMs !== undefined) {
    return { startMs: overlay.startMs, endMs: overlay.endMs };
  }
  if (overlay.span === "full") {
    return { startMs: 0, endMs: storyboard.durationMs };
  }
  const anchor = overlay.anchor;
  if (!anchor) {
    throw new Error(
      `Overlay ${overlay.id}: needs milliseconds, an anchor, or span "full"`,
    );
  }
  if ("startWordId" in anchor) {
    const start = words.words.find(
      (word) => word.id === anchor.startWordId,
    );
    const end = words.words.find(
      (word) => word.id === anchor.endWordId,
    );
    if (!start || !end) {
      throw new Error(
        `Overlay ${overlay.id}: anchor references a missing word id`,
      );
    }
    return { startMs: start.startMs, endMs: end.endMs };
  }

  const start = storyboard.scenes.find(
    (scene) => scene.id === anchor.startSceneId,
  );
  const end = storyboard.scenes.find(
    (scene) => scene.id === anchor.endSceneId,
  );
  if (!start || !end) {
    throw new Error(
      `Overlay ${overlay.id}: anchor references a missing scene id`,
    );
  }
  return { startMs: start.startMs, endMs: end.endMs };
};

export interface CompileTimelineOptions {
  project: string;
  styleId?: string;
}

export function compileProjectTimeline(
  options: CompileTimelineOptions,
): Timeline {
  const project = options.project;
  if (!PROJECT_NAME.test(project)) {
    throw new Error(`Invalid project name: ${project}`);
  }

  const style = loadStyle(options.styleId ?? DEFAULT_STYLE_ID);
  if (style.video.fps !== 30) {
    throw new Error(
      `Timeline v1 requires 30fps; style "${style.id}" declares ${style.video.fps}fps`,
    );
  }

  const projectDir = path.join(ROOT, "projects", project);
  const storyboardFile = path.join(projectDir, "storyboard", "storyboard.json");
  const wordsFile = path.join(projectDir, "voice", "words.json");
  const scriptFile = path.join(projectDir, "script", "script.md");
  for (const file of [storyboardFile, wordsFile, scriptFile]) {
    if (!existsSync(file)) throw new Error(`Missing ${file}`);
  }

  const storyboardResult = Storyboard.safeParse(readJson(storyboardFile));
  if (!storyboardResult.success) {
    throw new Error(formatIssues("Storyboard", storyboardResult.error.issues));
  }
  const wordsResult = WordTimings.safeParse(readJson(wordsFile));
  if (!wordsResult.success) {
    throw new Error(formatIssues("Word timings", wordsResult.error.issues));
  }

  const storyboard = storyboardResult.data;
  const words = wordsResult.data;
  if (storyboard.durationMs !== words.durationMs) {
    throw new Error(
      `Duration mismatch: storyboard is ${storyboard.durationMs} ms, audio is ${words.durationMs} ms`,
    );
  }
  const durationMs = words.durationMs;

  const videoClips = storyboard.scenes.map((scene) => ({
    id: scene.id,
    sceneId: scene.id,
    template: scene.template,
    layout: scene.layout,
    props: { ...scene.props } as Record<string, unknown>,
    startMs: scene.startMs,
    endMs: scene.endMs,
    anchor: scene.anchor,
    holdMs: scene.holdMs,
    transitionIn: scene.transitionIn
      ? { ...scene.transitionIn, overlapMs: 0 }
      : undefined,
  }));

  const overlayClips = storyboard.overlays.map((overlay) => {
    const timing = resolveOverlayTiming(overlay, storyboard, words);
    return {
      id: overlay.id,
      kind: overlay.kind,
      text: overlay.text,
      position: overlay.position,
      startMs: timing.startMs,
      endMs: timing.endMs,
      anchor: overlay.anchor,
      span: overlay.span,
    };
  });

  const narration: AudioClip = {
    id: "narration",
    kind: "narration",
    file: storyboard.audioFile,
    startMs: 0,
    endMs: durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    gain: 1,
  };

  const audioTracks: AudioTrack[] = [
    { kind: "audio", id: "audio-narration", clips: [narration] },
  ];

  if (storyboard.music) {
    const music: AudioClip = {
      id: "music",
      kind: "music",
      file: storyboard.music.file,
      startMs: 0,
      endMs: durationMs,
      sourceInMs: 0,
      sourceOutMs: durationMs,
      gain: storyboard.music.baseVolume,
      ducking: {
        gain: storyboard.music.duckedVolume,
        whenNarration: true,
      },
      fade: {
        inMs: storyboard.music.fadeMs,
        outMs: storyboard.music.fadeMs,
      },
    };
    audioTracks.push({
      kind: "audio",
      id: "audio-music",
      clips: [music],
    });
  }

  const markers = storyboard.scenes
    .filter(
      (scene, index, scenes) =>
        index === 0 || scene.chapter !== scenes[index - 1].chapter,
    )
    .map((scene) => ({
      atMs: scene.startMs,
      kind: "chapter" as const,
      label: `Chapter ${scene.chapter}`,
      chapterId: String(scene.chapter),
    }));

  const tracks: Timeline["tracks"] = [
    { kind: "video", id: "video-main", role: "program", clips: videoClips },
  ];
  if (overlayClips.length > 0) {
    tracks.push({ kind: "overlay", id: "overlay-main", clips: overlayClips });
  }
  tracks.push(...audioTracks);

  const timeline = {
    id: `${project}-timeline`,
    title: storyboard.title,
    durationMs,
    fps: 30 as const,
    width: style.video.width,
    height: style.video.height,
    tracks,
    markers,
    metadata: {
      styleId: style.id,
      project,
      sourceHashes: {
        script: hashFile(scriptFile),
        words: hashFile(wordsFile),
        storyboard: hashFile(storyboardFile),
      },
      compiler: { id: COMPILER_ID, version: COMPILER_VERSION },
      schemaVersion: 1 as const,
    },
  };

  const parsed = TimelineSchema.safeParse(timeline);
  if (!parsed.success) {
    throw new Error(formatIssues("Compiled timeline", parsed.error.issues));
  }
  return parsed.data;
}

/**
 * Independent of zod: the compiler wants one clear, actionable failure when
 * clip timing does not tile the timeline or a layer escapes the audio bed.
 */
export function assertTimelineCoverage(timeline: Timeline): void {
  const videoTracks = timeline.tracks.filter(
    (track): track is VideoTrack => track.kind === "video",
  );
  const programTracks = videoTracks.filter(
    (track) => track.role === "program",
  );
  if (programTracks.length !== 1) {
    throw new Error(
      `Timeline must have exactly one program video track, found ${programTracks.length}`,
    );
  }

  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (clip.startMs < 0) {
        throw new Error(
          `Video track ${track.id}: clip ${clip.id} starts before 0 ms`,
        );
      }
      if (clip.endMs <= clip.startMs) {
        throw new Error(
          `Video track ${track.id}: clip ${clip.id} has non-positive duration ${clip.startMs}-${clip.endMs} ms`,
        );
      }
      if (clip.endMs > timeline.durationMs) {
        throw new Error(
          `Video track ${track.id}: clip ${clip.id} ends at ${clip.endMs} ms, past the timeline duration ${timeline.durationMs} ms`,
        );
      }
    }
  }

  const program = programTracks[0];
  let cursor = 0;
  for (const clip of program.clips) {
    if (clip.startMs !== cursor) {
      const detail =
        clip.startMs > cursor
          ? `gap of ${clip.startMs - cursor} ms`
          : `overlap of ${cursor - clip.startMs} ms`;
      throw new Error(
        `Program video track ${program.id}: clip ${clip.id} starts at ${clip.startMs} ms, expected ${cursor} ms (${detail})`,
      );
    }
    cursor = clip.endMs;
  }
  if (cursor !== timeline.durationMs) {
    throw new Error(
      `Program video track ${program.id}: clips end at ${cursor} ms, expected ${timeline.durationMs} ms`,
    );
  }

  for (const track of timeline.tracks) {
    if (track.kind === "video") continue;
    for (const clip of track.clips) {
      if (clip.startMs < 0) {
        throw new Error(
          `${track.kind} clip ${clip.id}: startMs must not be negative`,
        );
      }
      if (clip.endMs <= clip.startMs) {
        throw new Error(
          `${track.kind} clip ${clip.id}: endMs must be after startMs`,
        );
      }
      if (clip.endMs > timeline.durationMs) {
        throw new Error(
          `${track.kind} clip ${clip.id}: ends at ${clip.endMs} ms, past the timeline duration ${timeline.durationMs} ms`,
        );
      }
    }
    if (track.kind === "audio") {
      for (const clip of track.clips) {
        if (clip.sourceOutMs <= clip.sourceInMs) {
          throw new Error(
            `Audio clip ${clip.id}: sourceOutMs must be after sourceInMs`,
          );
        }
      }
    }
  }

  for (const marker of timeline.markers) {
    if (marker.atMs < 0 || marker.atMs > timeline.durationMs) {
      throw new Error(
        `Marker ${marker.label}: atMs ${marker.atMs} is outside 0-${timeline.durationMs} ms`,
      );
    }
  }
}

interface CliOptions {
  project: string;
  out: string | null;
  dryRun: boolean;
  style: string | null;
}

const usage = () => {
  console.log(
    "Usage: npm run timeline:compile -- <project> [--out <path>] [--style <id>] [--dry-run]",
  );
};

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2);
  const project = args.shift();
  if (!project || project.startsWith("-")) {
    usage();
    process.exit(1);
  }
  if (!PROJECT_NAME.test(project)) {
    throw new Error(`Invalid project name: ${project}`);
  }

  const options: CliOptions = {
    project,
    out: null,
    dryRun: false,
    style: null,
  };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--out" || flag === "--style") {
      const value = args.shift();
      if (!value) throw new Error(`Missing value for ${flag}`);
      if (flag === "--out") options.out = value;
      else options.style = value;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
  return options;
};

const printSummary = (timeline: Timeline) => {
  const video = timeline.tracks.find(
    (track): track is VideoTrack => track.kind === "video",
  );
  const overlays = timeline.tracks.find(
    (track): track is OverlayTrack => track.kind === "overlay",
  );
  const audioClips = timeline.tracks
    .filter((track): track is AudioTrack => track.kind === "audio")
    .flatMap((track) => track.clips);
  const videoClips = video?.clips ?? [];

  console.log(`Timeline ${timeline.id}: ${timeline.title}`);
  console.log(
    `Duration ${timeline.durationMs} ms at ${timeline.fps}fps, ${timeline.width}x${timeline.height}`,
  );
  console.log(
    `Tracks: ${videoClips.length} video clips, ${overlays?.clips.length ?? 0} overlays, ${audioClips.length} audio clips, ${timeline.markers.length} markers`,
  );
  for (const clip of audioClips) {
    console.log(
      `Audio ${clip.kind}: ${clip.file} ${clip.startMs}-${clip.endMs} ms, gain ${clip.gain}`,
    );
  }
};

const main = () => {
  const options = parseArgs();
  const timeline = compileProjectTimeline({
    project: options.project,
    styleId: options.style ?? undefined,
  });
  assertTimelineCoverage(timeline);

  const outFile = options.out
    ? path.resolve(ROOT, options.out)
    : path.join(
        ROOT,
        "projects",
        options.project,
        "storyboard",
        "timeline.json",
      );

  printSummary(timeline);
  if (options.dryRun) {
    console.log("Dry run: no files written.");
    return;
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(timeline, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, outFile)}`);
};

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAILED: ${message}`);
    process.exit(1);
  }
}
