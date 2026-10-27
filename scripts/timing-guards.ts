export interface SceneTiming {
  id: string;
  startMs: number;
  endMs: number;
}

export interface WordLike {
  word: string;
  startMs: number;
  endMs: number;
}

export interface WordTrack {
  durationMs: number;
  words: WordLike[];
}

export interface BoundaryGuardOptions {
  fps?: number;
}

function nearestWords(words: WordLike[], atMs: number): string {
  let before: WordLike | undefined;
  let after: WordLike | undefined;
  for (const word of words) {
    if (word.endMs <= atMs) before = word;
    if (word.startMs >= atMs && !after) after = word;
    if (word.startMs > atMs && after) break;
  }
  const show = (word: WordLike | undefined) =>
    word ? `"${word.word}" ${word.startMs}-${word.endMs}ms` : "none";
  return `previous ${show(before)}, next ${show(after)}`;
}

/**
 * Allow a cut anywhere in a silence gap. A boundary may touch a word edge, and
 * a one-frame overlap tolerance keeps integer/30fps rounding from rejecting a
 * boundary that is visually on the cut. Anything deeper inside a word is a
 * mid-word cut.
 */
export function assertBoundariesInGaps(
  scenes: SceneTiming[],
  track: WordTrack,
  options: BoundaryGuardOptions = {},
): void {
  if (scenes.length === 0) throw new Error("storyboard has no scenes");
  const fps = options.fps ?? 30;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`invalid fps for boundary guard: ${fps}`);
  }
  const frameMs = 1000 / fps;
  const durationMs = track.durationMs;

  if (scenes[0].startMs !== 0) {
    throw new Error(
      `scene ${scenes[0].id} must start at 0 ms, got ${scenes[0].startMs} ms`,
    );
  }

  let previousEnd = 0;
  for (const scene of scenes) {
    if (scene.startMs < previousEnd) {
      throw new Error(
        `scenes are not sorted: ${scene.id} starts at ${scene.startMs} ms ` +
          `before the previous scene ends at ${previousEnd} ms`,
      );
    }
    if (scene.startMs !== previousEnd) {
      throw new Error(
        `scene ${scene.id} must start when the previous scene ends ` +
          `(${previousEnd} ms), got ${scene.startMs} ms`,
      );
    }
    if (scene.endMs <= scene.startMs) {
      throw new Error(
        `scene ${scene.id} has non-positive duration ` +
          `${scene.startMs}-${scene.endMs} ms`,
      );
    }
    if (scene.endMs > durationMs) {
      throw new Error(
        `scene ${scene.id} ends at ${scene.endMs} ms, past the audio ` +
          `duration ${durationMs} ms`,
      );
    }
    previousEnd = scene.endMs;
  }

  if (previousEnd !== durationMs) {
    throw new Error(
      `last scene must end at the audio duration ${durationMs} ms, ` +
        `it ends at ${previousEnd} ms`,
    );
  }

  const boundaries = new Map<number, string[]>();
  for (const scene of scenes) {
    for (const atMs of [scene.startMs, scene.endMs]) {
      const labels = boundaries.get(atMs) ?? [];
      const label = `scene ${scene.id}`;
      if (!labels.includes(label)) labels.push(label);
      boundaries.set(atMs, labels);
    }
  }

  for (const [atMs, labels] of boundaries) {
    if (atMs < 0 || atMs > durationMs) {
      throw new Error(
        `${labels.join(", ")} boundary ${atMs} ms is outside 0-${durationMs} ms`,
      );
    }
    const inside = track.words.find(
      (word) =>
        word.startMs + frameMs < atMs && atMs < word.endMs - frameMs,
    );
    if (inside) {
      throw new Error(
        `mid-word cut at ${atMs} ms (${labels.join(", ")}): inside ` +
          `"${inside.word}" ${inside.startMs}-${inside.endMs} ms; ` +
          nearestWords(track.words, atMs),
      );
    }
  }
}
