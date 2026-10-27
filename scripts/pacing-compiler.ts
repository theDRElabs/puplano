import { z } from "zod";
import { Storyboard } from "../schemas/storyboard";
import type { WordSpan } from "../schemas/storyboard";
import { WordTimings } from "../schemas/words";
import type { StyleProfile } from "../schemas/style";

export type StoryboardData = z.infer<typeof Storyboard>;
export type WordsData = z.infer<typeof WordTimings>;

export const DEFAULT_FPS = 30;
export const BOUNDARY_GUARD_MS = 34;
export const BOUNDARY_PAD_MS = 80;
export const SENTENCE_END_WINDOW_MS = 600;
export const MIN_SENTENCE_END_SHARE = 0.6;

export const DEFAULT_ARC_TARGETS: Record<string, number> = {
  open_high: 14,
  mid_ease: 10,
  climax_accel: 12.5,
  resolve_hold: 8,
};

export interface CompileOptions {
  fps?: number;
  padMs?: number;
  guardMs?: number;
  minShotMs?: number;
  minSentenceEndShare?: number;
  arcTargets?: Record<string, number>;
}

export interface ShotMetrics {
  durationMs: number;
  sceneCount: number;
  cuts: number;
  cutsPerMinute: number;
  medianShotMs: number;
  p90ShotMs: number;
  minShotMs: number;
  shortShotShare: number;
  longShotShare: number;
  sentenceEndCuts: number;
  cutOnSentenceEnd: number;
}

export interface BoundaryRow {
  sceneId: string;
  boundaryMs: number;
  lastWordId: string;
  holdRequestedMs: number;
  holdEffectiveMs: number;
  gapMs: number;
}

export interface ArcMetric {
  label: string;
  targetCutsPerMinute?: number;
  sceneCount: number;
  durationMs: number;
  cuts: number;
  cutsPerMinute: number;
  meanShotMs: number;
  pass: boolean;
}

export interface TimingReport {
  generatedBy: string;
  words: { durationMs: number; wordCount: number };
  settings: {
    fps: number;
    padMs: number;
    guardMs: number;
    minShotMs: number;
    minSentenceEndShare: number;
    arcTargets: Record<string, number>;
  };
  before: ShotMetrics;
  after: ShotMetrics & {
    holds: {
      count: number;
      requestedTotalMs: number;
      effectiveTotalMs: number;
      clampedCount: number;
      maxRequestedMs: number;
      maxEffectiveMs: number;
    };
  };
  targets: {
    cutsPerMinute: number;
    medianShotMs: number;
    minShotMs: number;
    longShotShare: number;
    cutOnSentenceEnd: number;
    arcCutsPerMinute: Record<string, number>;
  };
  pass: {
    minShot: boolean;
    sentenceEnd: boolean;
    style: {
      cutsPerMinute: boolean;
      medianShot: boolean;
      longShotShare: boolean;
      cutOnSentenceEnd: boolean;
    };
  };
  arcs: ArcMetric[];
  boundaries: BoundaryRow[];
  warnings: string[];
}

export interface CompileResult {
  storyboard: StoryboardData;
  report: TimingReport;
}

type WordLike = { word: string; startMs: number; endMs: number };
type SceneLike = { id: string; startMs: number; endMs: number };

const TOKEN_PATTERN = /[a-z0-9]+(?:['’.:][a-z0-9]+)*/gi;
const SENTENCE_END = /[.!?](?:["'”’)\]]*)\s*$/;

export function tokenize(text: string): string[] {
  return (text.match(TOKEN_PATTERN) ?? []).map((token) =>
    token.toLowerCase().replace(/’/g, "'"),
  );
}

export function isSentenceFinal(text: string): boolean {
  return SENTENCE_END.test(text);
}

function isSentenceEndingWord(word: string): boolean {
  return SENTENCE_END.test(word);
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.9) - 1),
  );
  return sorted[index];
}

function lastWordEndingAtOrBefore(words: WordLike[], timeMs: number): number {
  let low = 0;
  let high = words.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (words[middle].endMs <= timeMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function computeShotMetrics(
  scenes: ReadonlyArray<SceneLike>,
  words: ReadonlyArray<WordLike>,
  durationMs: number,
): ShotMetrics {
  if (scenes.length === 0) throw new Error("cannot measure an empty storyboard");
  const durations = scenes.map((scene) => scene.endMs - scene.startMs);
  const cuts = Math.max(0, scenes.length - 1);
  let sentenceEndCuts = 0;

  for (let index = 1; index < scenes.length; index += 1) {
    const cut = scenes[index].startMs;
    const wordIndex = lastWordEndingAtOrBefore(words as WordLike[], cut);
    if (wordIndex < 0) continue;
    const word = words[wordIndex];
    const afterMs = cut - word.endMs;
    if (
      afterMs >= 0 &&
      afterMs <= SENTENCE_END_WINDOW_MS &&
      isSentenceEndingWord(word.word)
    ) {
      sentenceEndCuts += 1;
    }
  }

  const share = (test: (duration: number) => boolean) =>
    roundTo(durations.filter(test).length / durations.length, 3);

  return {
    durationMs,
    sceneCount: scenes.length,
    cuts,
    cutsPerMinute:
      durationMs > 0 ? roundTo(cuts / (durationMs / 60000), 2) : 0,
    medianShotMs: Math.round(median(durations)),
    p90ShotMs: Math.round(p90(durations)),
    minShotMs: Math.min(...durations),
    shortShotShare: share((duration) => duration < 4000),
    longShotShare: share((duration) => duration >= 6000),
    sentenceEndCuts,
    cutOnSentenceEnd: cuts > 0 ? roundTo(sentenceEndCuts / cuts, 3) : 1,
  };
}

function buildWordIndex(words: WordsData): Map<string, number> {
  const index = new Map<string, number>();
  words.words.forEach((word, position) => {
    if (index.has(word.id)) {
      throw new Error(`duplicate word id in voice/words.json: ${word.id}`);
    }
    index.set(word.id, position);
  });
  return index;
}

function resolveSpan(
  span: WordSpan,
  index: Map<string, number>,
  sceneId: string,
): { startIndex: number; endIndex: number } {
  const startIndex = index.get(span.startWordId);
  const endIndex = index.get(span.endWordId);
  if (startIndex === undefined) {
    throw new Error(`scene ${sceneId}: unknown startWordId ${span.startWordId}`);
  }
  if (endIndex === undefined) {
    throw new Error(`scene ${sceneId}: unknown endWordId ${span.endWordId}`);
  }
  if (startIndex > endIndex) {
    throw new Error(
      `scene ${sceneId}: reversed word span ${span.startWordId}..${span.endWordId}`,
    );
  }
  return { startIndex, endIndex };
}

function resolveScene(
  scene: StoryboardData["scenes"][number],
  words: WordsData,
  index: Map<string, number>,
): { startIndex: number; endIndex: number } {
  if (!scene.anchor) {
    throw new Error(`scene ${scene.id}: missing anchor`);
  }
  if (!scene.narration?.trim()) {
    throw new Error(`scene ${scene.id}: anchor requires narration`);
  }
  const { startIndex, endIndex } = resolveSpan(scene.anchor, index, scene.id);
  const actual = words.words
    .slice(startIndex, endIndex + 1)
    .flatMap((word) => tokenize(word.word));
  const expected = tokenize(scene.narration);
  if (actual.join("\u0000") !== expected.join("\u0000")) {
    throw new Error(
      `scene ${scene.id}: anchor ${scene.anchor.startWordId}..${scene.anchor.endWordId} ` +
        `resolves to "${actual.join(" ")}" but narration is "${expected.join(" ")}"`,
    );
  }
  if (!isSentenceFinal(scene.narration)) {
    throw new Error(
      `scene ${scene.id} ends mid-sentence: "${scene.narration.trim()}"; ` +
        "end the scene on sentence punctuation",
    );
  }
  return { startIndex, endIndex };
}

function quantizeBoundary(
  desiredMs: number,
  lowerMs: number,
  upperMs: number,
  frameMs: number,
): number {
  const minFrame = Math.ceil(lowerMs / frameMs - 1e-9);
  const maxFrame = Math.floor(upperMs / frameMs + 1e-9);
  if (minFrame > maxFrame) {
    throw new Error(
      `no one-frame-safe boundary between ${lowerMs} and ${upperMs} ms`,
    );
  }
  const frame = Math.min(
    maxFrame,
    Math.max(minFrame, Math.round(desiredMs / frameMs)),
  );
  return Math.round(frame * frameMs);
}

function arcSizes(sceneCount: number): number[] {
  const base = Math.floor(sceneCount / 4);
  const remainder = sceneCount % 4;
  return Array.from({ length: 4 }, (_, index) =>
    base + (index < remainder ? 1 : 0),
  );
}

function buildArcs(
  scenes: StoryboardData["scenes"],
  labels: string[],
  targets: Record<string, number>,
): ArcMetric[] {
  const arcs: ArcMetric[] = [];
  let cursor = 0;
  const lastId = scenes.at(-1)?.id;
  arcSizes(scenes.length).forEach((size, arcIndex) => {
    const group = scenes.slice(cursor, cursor + size);
    cursor += size;
    const arcDuration = group.reduce(
      (sum, scene) => sum + scene.endMs - scene.startMs,
      0,
    );
    const cuts = group.filter((scene) => scene.id !== lastId).length;
    const label = labels[arcIndex] ?? `arc${arcIndex + 1}`;
    const target = targets[label];
    const actual =
      arcDuration > 0 ? roundTo(cuts / (arcDuration / 60000), 2) : 0;
    const pass =
      target === undefined ||
      Math.abs(actual - target) <= Math.max(2, target * 0.2);
    arcs.push({
      label,
      targetCutsPerMinute: target,
      sceneCount: group.length,
      durationMs: arcDuration,
      cuts,
      cutsPerMinute: actual,
      meanShotMs: group.length > 0 ? Math.round(arcDuration / group.length) : 0,
      pass,
    });
  });
  return arcs;
}

function within(
  actual: number,
  target: number,
  relative: number,
  absoluteFloor: number,
): boolean {
  return Math.abs(actual - target) <= Math.max(absoluteFloor, target * relative);
}

function overlayTiming(
  overlay: StoryboardData["overlays"][number],
  words: WordsData,
  wordIndex: Map<string, number>,
  scenes: StoryboardData["scenes"],
  durationMs: number,
): { startMs: number; endMs: number } {
  if (overlay.span === "full") {
    return { startMs: 0, endMs: durationMs };
  }

  if (overlay.anchor) {
    if ("startWordId" in overlay.anchor) {
      const { startIndex, endIndex } = resolveSpan(
        overlay.anchor,
        wordIndex,
        `overlay ${overlay.id}`,
      );
      return {
        startMs: Math.max(
          0,
          Math.min(durationMs, words.words[startIndex].startMs),
        ),
        endMs: Math.max(
          0,
          Math.min(durationMs, words.words[endIndex].endMs),
        ),
      };
    }
    const anchor = overlay.anchor;
    const startScene = scenes.findIndex(
      (scene) => scene.id === anchor.startSceneId,
    );
    const endScene = scenes.findIndex(
      (scene) => scene.id === anchor.endSceneId,
    );
    if (startScene < 0 || endScene < 0) {
      throw new Error(
        `overlay ${overlay.id}: unknown scene anchor ` +
          `${anchor.startSceneId}..${anchor.endSceneId}`,
      );
    }
    if (startScene > endScene) {
      throw new Error(
        `overlay ${overlay.id}: reversed scene anchor ` +
          `${anchor.startSceneId}..${anchor.endSceneId}`,
      );
    }
    const start = scenes[startScene];
    const end = scenes[endScene];
    if (!start || !end) {
      throw new Error(
        `overlay ${overlay.id}: scene anchor resolved to a missing scene`,
      );
    }
    return {
      startMs: Math.max(0, Math.min(durationMs, start.startMs)),
      endMs: Math.max(0, Math.min(durationMs, end.endMs)),
    };
  }

  if (overlay.startMs === undefined || overlay.endMs === undefined) {
    throw new Error(
      `overlay ${overlay.id}: needs startMs/endMs, a word/scene anchor, or span "full"`,
    );
  }
  return { startMs: overlay.startMs, endMs: overlay.endMs };
}

export function compileStoryboard(args: {
  storyboard: StoryboardData;
  words: WordsData;
  style: StyleProfile;
  options?: CompileOptions;
}): CompileResult {
  const { storyboard, words, style, options = {} } = args;
  const fps = options.fps ?? style.video.fps ?? DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`invalid fps: ${fps}`);
  const frameMs = 1000 / fps;
  const padMs = options.padMs ?? BOUNDARY_PAD_MS;
  const guardMs = options.guardMs ?? BOUNDARY_GUARD_MS;
  const minShotMs = options.minShotMs ?? style.pacing.minShotMs;
  const minSentenceEndShare =
    options.minSentenceEndShare ?? MIN_SENTENCE_END_SHARE;
  const arcTargets = options.arcTargets ?? DEFAULT_ARC_TARGETS;

  if (storyboard.scenes.length === 0) throw new Error("storyboard has no scenes");

  const wordIndex = buildWordIndex(words);
  const resolved = storyboard.scenes.map((scene) =>
    resolveScene(scene, words, wordIndex),
  );

  resolved.forEach((span, index) => {
    if (index === 0) return;
    if (span.startIndex <= resolved[index - 1].endIndex) {
      throw new Error(
        `scene ${storyboard.scenes[index].id}: anchor starts before the ` +
          `previous scene (${storyboard.scenes[index - 1].id}) ends`,
      );
    }
  });

  const starts = new Array<number>(storyboard.scenes.length).fill(0);
  const ends = new Array<number>(storyboard.scenes.length).fill(0);
  const boundaries: BoundaryRow[] = [];
  starts[0] = 0;

  for (let index = 0; index < storyboard.scenes.length - 1; index += 1) {
    const scene = storyboard.scenes[index];
    const nextScene = storyboard.scenes[index + 1];
    const lastWord = words.words[resolved[index].endIndex];
    const nextWord = words.words[resolved[index + 1].startIndex];
    const holdRequested = scene.holdMs ?? 0;
    const desired = lastWord.endMs + holdRequested + padMs;
    const lower = lastWord.endMs + guardMs;
    const upper = nextWord.startMs - guardMs;
    if (upper < lower) {
      throw new Error(
        `scene ${scene.id} (${nextScene.id}): gap ${lastWord.endMs}-` +
          `${nextWord.startMs} ms is too short for a safe boundary`,
      );
    }
    let boundary: number;
    try {
      boundary = quantizeBoundary(desired, lower, upper, frameMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`scene ${scene.id} (${nextScene.id}): ${message}`);
    }
    const holdEffective = Math.max(
      0,
      Math.round(boundary - lastWord.endMs - padMs),
    );
    boundaries.push({
      sceneId: scene.id,
      boundaryMs: boundary,
      lastWordId: lastWord.id,
      holdRequestedMs: holdRequested,
      holdEffectiveMs: holdEffective,
      gapMs: Math.round(nextWord.startMs - lastWord.endMs),
    });
    ends[index] = boundary;
    starts[index + 1] = boundary;
  }
  ends[ends.length - 1] = words.durationMs;

  const compiledScenes = storyboard.scenes.map((scene, index) => {
    const startMs = starts[index];
    const endMs = ends[index];
    const duration = endMs - startMs;
    if (duration < minShotMs) {
      throw new Error(
        `scene ${scene.id}: shot ${startMs}-${endMs} (${duration} ms) is ` +
          `shorter than minShotMs ${minShotMs}`,
      );
    }
    if (duration <= 0) {
      throw new Error(`scene ${scene.id}: non-positive duration ${duration} ms`);
    }
    return { ...scene, startMs, endMs };
  });

  const compiledOverlays = storyboard.overlays.map((overlay) => {
    const timing = overlayTiming(
      overlay,
      words,
      wordIndex,
      compiledScenes,
      words.durationMs,
    );
    if (timing.endMs <= timing.startMs) {
      throw new Error(
        `overlay ${overlay.id}: resolved end ${timing.endMs} ms is not after ` +
          `start ${timing.startMs} ms`,
      );
    }
    return { ...overlay, ...timing };
  });

  const compiled: StoryboardData = {
    ...storyboard,
    durationMs: words.durationMs,
    scenes: compiledScenes,
    overlays: compiledOverlays,
  };

  const before = computeShotMetrics(
    storyboard.scenes,
    words.words,
    storyboard.durationMs,
  );
  const measured = computeShotMetrics(
    compiledScenes,
    words.words,
    words.durationMs,
  );

  if (measured.cutOnSentenceEnd < minSentenceEndShare) {
    throw new Error(
      `cut-on-sentence-end share ${measured.cutOnSentenceEnd.toFixed(3)} is ` +
        `below the required ${minSentenceEndShare.toFixed(2)}`,
    );
  }

  const requestedTotal = boundaries.reduce(
    (sum, row) => sum + row.holdRequestedMs,
    0,
  );
  const effectiveTotal = boundaries.reduce(
    (sum, row) => sum + row.holdEffectiveMs,
    0,
  );
  const after = {
    ...measured,
    holds: {
      count: boundaries.length,
      requestedTotalMs: requestedTotal,
      effectiveTotalMs: effectiveTotal,
      clampedCount: boundaries.filter(
        (row) => row.holdEffectiveMs < row.holdRequestedMs,
      ).length,
      maxRequestedMs: Math.max(
        0,
        ...boundaries.map((row) => row.holdRequestedMs),
      ),
      maxEffectiveMs: Math.max(
        0,
        ...boundaries.map((row) => row.holdEffectiveMs),
      ),
    },
  };

  const stylePass = {
    cutsPerMinute: within(
      measured.cutsPerMinute,
      style.pacing.cutsPerMinute,
      0.15,
      1,
    ),
    medianShot: within(
      measured.medianShotMs,
      style.pacing.medianShotMs,
      0.15,
      300,
    ),
    longShotShare: within(
      measured.longShotShare,
      style.pacing.longShotShare,
      0.2,
      0.05,
    ),
    cutOnSentenceEnd:
      measured.cutOnSentenceEnd >= style.pacing.cutOnSentenceEnd,
  };

  const warnings: string[] = [];
  if (!stylePass.cutsPerMinute) {
    warnings.push(
      `style cuts/min: ${measured.cutsPerMinute} vs target ` +
        `${style.pacing.cutsPerMinute}`,
    );
  }
  if (!stylePass.medianShot) {
    warnings.push(
      `style median shot: ${measured.medianShotMs} ms vs target ` +
        `${style.pacing.medianShotMs} ms`,
    );
  }
  if (!stylePass.longShotShare) {
    warnings.push(
      `style long-shot share: ${measured.longShotShare} vs target ` +
        `${style.pacing.longShotShare}`,
    );
  }
  if (!stylePass.cutOnSentenceEnd) {
    warnings.push(
      `style sentence-end cut share: ${measured.cutOnSentenceEnd} vs target ` +
        `${style.pacing.cutOnSentenceEnd}`,
    );
  }

  const arcs = buildArcs(
    compiledScenes,
    style.pacing.curve,
    arcTargets,
  );
  arcs.forEach((arc) => {
    if (!arc.pass) {
      warnings.push(
        `arc ${arc.label}: ${arc.cutsPerMinute} cuts/min vs target ` +
          `${arc.targetCutsPerMinute}`,
      );
    }
  });

  return {
    storyboard: compiled,
    report: {
      generatedBy: "scripts/compile-timing.ts",
      words: { durationMs: words.durationMs, wordCount: words.words.length },
      settings: {
        fps,
        padMs,
        guardMs,
        minShotMs,
        minSentenceEndShare,
        arcTargets,
      },
      before,
      after,
      targets: {
        cutsPerMinute: style.pacing.cutsPerMinute,
        medianShotMs: style.pacing.medianShotMs,
        minShotMs: style.pacing.minShotMs,
        longShotShare: style.pacing.longShotShare,
        cutOnSentenceEnd: style.pacing.cutOnSentenceEnd,
        arcCutsPerMinute: arcTargets,
      },
      pass: {
        minShot: measured.minShotMs >= minShotMs,
        sentenceEnd: measured.cutOnSentenceEnd >= minSentenceEndShare,
        style: stylePass,
      },
      arcs,
      boundaries,
      warnings,
    },
  };
}

export function inferAnchors(
  storyboard: StoryboardData,
  words: WordsData,
): StoryboardData {
  const flat: Array<{ token: string; wordIndex: number }> = [];
  words.words.forEach((word, wordIndex) => {
    tokenize(word.word).forEach((token) => flat.push({ token, wordIndex }));
  });

  let cursor = 0;
  const scenes = storyboard.scenes.map((scene) => {
    if (!scene.narration?.trim()) {
      throw new Error(`scene ${scene.id}: cannot infer an anchor without narration`);
    }
    const expected = tokenize(scene.narration);
    if (expected.length === 0) {
      throw new Error(`scene ${scene.id}: narration has no matchable words`);
    }

    let found = -1;
    for (
      let start = cursor;
      start + expected.length <= flat.length;
      start += 1
    ) {
      let matched = true;
      for (let offset = 0; offset < expected.length; offset += 1) {
        if (flat[start + offset].token !== expected[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        found = start;
        break;
      }
    }

    if (found < 0) {
      throw new Error(
        `scene ${scene.id}: narration does not match the remaining word timings`,
      );
    }

    const first = flat[found];
    const last = flat[found + expected.length - 1];
    const before = found > 0 ? flat[found - 1] : undefined;
    const after = flat[found + expected.length];
    if (before && before.wordIndex === first.wordIndex) {
      throw new Error(`scene ${scene.id}: narration starts inside a word`);
    }
    if (after && after.wordIndex === last.wordIndex) {
      throw new Error(`scene ${scene.id}: narration ends inside a word`);
    }

    cursor = found + expected.length;
    return {
      ...scene,
      anchor: {
        startWordId: words.words[first.wordIndex].id,
        endWordId: words.words[last.wordIndex].id,
      },
    };
  });

  return { ...storyboard, scenes };
}
