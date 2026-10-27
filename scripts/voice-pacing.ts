export const DEFAULT_MAX_CHARS = 420;
export const MIN_SPEED = 0.7;
export const MAX_SPEED = 1.2;
export const PAUSE_GAP_MS = 350;

export type SegmentKind = "sentence" | "paragraph" | "directed" | "continuous";

export interface Segment {
  text: string;
  pauseAfterMs: number;
  kind: SegmentKind;
  words: number;
}

export interface SegmentPlan {
  segments: Segment[];
  pauseBudgetMs: number;
  tailMs: number;
  estimatedSpeechMs: number;
  estimatedTotalMs: number;
}

export interface PlanOptions {
  maxChars?: number;
  wpmSpoken: number;
  silenceRatio: number;
  sentencePauseMs: [number, number];
  paragraphPauseMs: [number, number];
  tailMs: number;
  seed: number | string;
}

export interface ScriptSentence {
  index: number;
  paragraph: number;
  text: string;
  wordCount: number;
  isParagraphEnd: boolean;
}

export interface DirectedPauseInput {
  afterSentence: number;
  targetGapMs: number;
}

export interface DirectedPlanOptions {
  maxChars: number;
  wpmSpoken: number;
  tailMs: number;
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface PacingTargets {
  wpmSpoken: number;
  wpmTotal: number;
  silenceRatio: number;
  pausesPerMinute: number;
}

export interface PacingTolerances {
  wpmRelative: number;
  silenceRatio: number;
  pausesPerMinute: number;
}

export interface PacingPass {
  wpmSpoken: boolean;
  wpmTotal: boolean;
  silenceRatio: boolean;
  pausesPerMinute: boolean;
}

export interface PacingReport {
  totalWords: number;
  durationMs: number;
  wpmTotal: number;
  wpmSpoken: number;
  silenceRatio: number;
  pauseCount: number;
  pausesPerMinute: number;
  pauseMedianMs: number;
  pauseP90Ms: number;
  targets: PacingTargets;
  tolerances: PacingTolerances;
  pass: PacingPass;
  passed: boolean;
}

const DEFAULT_TOLERANCES: PacingTolerances = {
  wpmRelative: 0.1,
  silenceRatio: 0.03,
  pausesPerMinute: 3,
};

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function validateRange(name: string, range: [number, number]): void {
  const [min, max] = range;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new Error(`Invalid ${name} range: [${min}, ${max}]`);
  }
}

export function validateSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new Error(
      `Invalid speed ${speed}: expected a number between ${MIN_SPEED} and ${MAX_SPEED}`,
    );
  }
  return speed;
}

export function readParagraphs(scriptText: string): string[] {
  return scriptText
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?]["')\]]?)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];

  const parts: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > maxChars) {
      parts.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function hashString(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function roundToTenMs(value: number, hash: number): number {
  const steps = value / 10;
  const floor = Math.floor(steps);
  const fraction = steps - floor;
  const threshold = (hash % 1000) / 1000;
  return (fraction > threshold ? floor + 1 : floor) * 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function planSegments(
  paragraphs: string[],
  options: PlanOptions,
): SegmentPlan {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error(`Invalid maxChars: ${maxChars}`);
  }
  if (!Number.isFinite(options.wpmSpoken) || options.wpmSpoken <= 0) {
    throw new Error(`Invalid wpmSpoken: ${options.wpmSpoken}`);
  }
  if (
    !Number.isFinite(options.silenceRatio) ||
    options.silenceRatio < 0 ||
    options.silenceRatio >= 1
  ) {
    throw new Error(`Invalid silenceRatio: ${options.silenceRatio}`);
  }
  validateRange("sentencePauseMs", options.sentencePauseMs);
  validateRange("paragraphPauseMs", options.paragraphPauseMs);
  if (!Number.isFinite(options.tailMs) || options.tailMs < 0) {
    throw new Error(`Invalid tailMs: ${options.tailMs}`);
  }

  const segments: Segment[] = [];

  for (const paragraph of paragraphs) {
    const normalized = paragraph.replace(/\s+/g, " ").trim();
    if (!normalized) continue;

    const sentences = splitSentences(normalized).flatMap((sentence) =>
      splitLongSentence(sentence, maxChars),
    );
    const groups: string[][] = [];
    let group: string[] = [];

    for (const sentence of sentences) {
      const candidate = [...group, sentence].join(" ");
      if (
        group.length > 0 &&
        (group.length >= 3 || candidate.length > maxChars)
      ) {
        groups.push(group);
        group = [];
      }
      group.push(sentence);
    }
    if (group.length > 0) groups.push(group);

    groups.forEach((sentencesInGroup, index) => {
      const text = sentencesInGroup.join(" ");
      segments.push({
        text,
        pauseAfterMs: 0,
        kind: index === groups.length - 1 ? "paragraph" : "sentence",
        words: countWords(text),
      });
    });
  }

  const totalWords = segments.reduce((sum, segment) => sum + segment.words, 0);
  const estimatedSpeechMs = Math.round(
    (totalWords / (options.wpmSpoken / 60)) * 1000,
  );
  const pauseBudgetMs = Math.round(
    estimatedSpeechMs * (options.silenceRatio / (1 - options.silenceRatio)),
  );

  if (segments.length > 1 && pauseBudgetMs > 0) {
    const [sentenceMin, sentenceMax] = options.sentencePauseMs;
    const [paragraphMin, paragraphMax] = options.paragraphPauseMs;
    const seams = segments.slice(0, -1).map((segment, index) => {
      const isParagraph = segment.kind === "paragraph";
      return {
        index,
        kind: segment.kind,
        min: isParagraph ? paragraphMin : sentenceMin,
        max: isParagraph ? paragraphMax : sentenceMax,
        weight: isParagraph ? 2.5 : 1,
        pause: 0,
      };
    });

    const totalWeight = seams.reduce((sum, seam) => sum + seam.weight, 0);
    for (const seam of seams) {
      seam.pause = clamp(
        (pauseBudgetMs * seam.weight) / totalWeight,
        seam.min,
        seam.max,
      );
    }

    let remainder =
      pauseBudgetMs - seams.reduce((sum, seam) => sum + seam.pause, 0);

    if (remainder > 0) {
      const paragraphSeams = seams.filter((seam) => seam.kind === "paragraph");
      const capacity = paragraphSeams.reduce(
        (sum, seam) => sum + Math.max(0, seam.max * 2 - seam.pause),
        0,
      );
      if (capacity > 0) {
        const toAdd = Math.min(remainder, capacity);
        for (const seam of paragraphSeams) {
          const room = Math.max(0, seam.max * 2 - seam.pause);
          if (room > 0) seam.pause += toAdd * (room / capacity);
        }
      }
    } else if (remainder < 0) {
      const reducible = seams.reduce(
        (sum, seam) => sum + Math.max(0, seam.pause - seam.min),
        0,
      );
      if (reducible > 0) {
        const toRemove = Math.min(-remainder, reducible);
        for (const seam of seams) {
          const room = Math.max(0, seam.pause - seam.min);
          if (room > 0) seam.pause -= toRemove * (room / reducible);
        }
      }
    }

    for (const seam of seams) {
      const seamText = `${segments[seam.index].text}\u0000${
        segments[seam.index + 1].text
      }`;
      const hash = hashString(`${options.seed}|${seamText}`);
      const upper = seam.kind === "paragraph" ? seam.max * 2 : seam.max;
      const rounded = clamp(roundToTenMs(seam.pause, hash), seam.min, upper);
      segments[seam.index].pauseAfterMs = rounded;
    }
  }

  const pauseTotal = segments.reduce(
    (sum, segment) => sum + segment.pauseAfterMs,
    0,
  );

  return {
    segments,
    pauseBudgetMs,
    tailMs: options.tailMs,
    estimatedSpeechMs,
    estimatedTotalMs: estimatedSpeechMs + pauseTotal + options.tailMs,
  };
}

export function readSentences(paragraphs: string[]): ScriptSentence[] {
  const sentences: ScriptSentence[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const normalized = paragraph.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const split = splitSentences(normalized);
    split.forEach((text, sentenceIndex) => {
      sentences.push({
        index: sentences.length + 1,
        paragraph: paragraphIndex + 1,
        text,
        wordCount: countWords(text),
        isParagraphEnd: sentenceIndex === split.length - 1,
      });
    });
  });
  return sentences;
}

export function planDirectedSegments(
  paragraphs: string[],
  pauses: DirectedPauseInput[],
  options: DirectedPlanOptions,
): SegmentPlan {
  const sentences = readSentences(paragraphs);
  if (sentences.length < 2) {
    throw new Error("Directed pause planning needs at least two sentences");
  }
  if (!Number.isFinite(options.maxChars) || options.maxChars <= 0) {
    throw new Error(`Invalid maxChars: ${options.maxChars}`);
  }
  if (!Number.isFinite(options.wpmSpoken) || options.wpmSpoken <= 0) {
    throw new Error(`Invalid wpmSpoken: ${options.wpmSpoken}`);
  }
  if (!Number.isFinite(options.tailMs) || options.tailMs < 0) {
    throw new Error(`Invalid tailMs: ${options.tailMs}`);
  }

  const ordered = [...pauses].sort(
    (left, right) => left.afterSentence - right.afterSentence,
  );
  const seen = new Set<number>();
  for (const pause of ordered) {
    if (
      !Number.isInteger(pause.afterSentence) ||
      pause.afterSentence < 1 ||
      pause.afterSentence >= sentences.length
    ) {
      throw new Error(
        `Directed pause afterSentence must be 1..${sentences.length - 1}, ` +
          `received ${pause.afterSentence}`,
      );
    }
    if (seen.has(pause.afterSentence)) {
      throw new Error(
        `Duplicate directed pause after sentence ${pause.afterSentence}`,
      );
    }
    seen.add(pause.afterSentence);
    if (
      !Number.isFinite(pause.targetGapMs) ||
      pause.targetGapMs < 0 ||
      pause.targetGapMs > 5000
    ) {
      throw new Error(
        `Invalid directed pause gap ${pause.targetGapMs}ms after sentence ` +
          `${pause.afterSentence}`,
      );
    }
  }

  const segments: Segment[] = [];
  const appendGroup = (group: ScriptSentence[], pauseAfterMs: number) => {
    if (group.length === 0) {
      throw new Error("Directed pause produced an empty speech segment");
    }
    let chunk: ScriptSentence[] = [];
    const flush = (isLast: boolean) => {
      if (chunk.length === 0) return;
      const text = chunk.map((sentence) => sentence.text).join(" ");
      segments.push({
        text,
        pauseAfterMs: isLast ? pauseAfterMs : 0,
        kind: isLast && pauseAfterMs > 0 ? "directed" : "continuous",
        words: countWords(text),
      });
      chunk = [];
    };
    for (const sentence of group) {
      const candidate = [...chunk, sentence]
        .map((entry) => entry.text)
        .join(" ");
      if (chunk.length > 0 && candidate.length > options.maxChars) {
        flush(false);
      }
      chunk.push(sentence);
    }
    flush(true);
  };

  let cursor = 0;
  for (const pause of ordered) {
    appendGroup(
      sentences.slice(cursor, pause.afterSentence),
      pause.targetGapMs,
    );
    cursor = pause.afterSentence;
  }
  appendGroup(sentences.slice(cursor), 0);

  const totalWords = segments.reduce((sum, segment) => sum + segment.words, 0);
  const estimatedSpeechMs = Math.round(
    (totalWords / (options.wpmSpoken / 60)) * 1000,
  );
  const pauseBudgetMs = ordered.reduce(
    (sum, pause) => sum + pause.targetGapMs,
    0,
  );
  return {
    segments,
    pauseBudgetMs,
    tailMs: options.tailMs,
    estimatedSpeechMs,
    estimatedTotalMs: estimatedSpeechMs + pauseBudgetMs + options.tailMs,
  };
}

export function applyOffsets(
  words: WordTiming[][],
  segmentDurationsMs: number[],
  pauseAfterMs: number[],
): WordTiming[] {
  if (
    words.length !== segmentDurationsMs.length ||
    words.length !== pauseAfterMs.length
  ) {
    throw new Error(
      "applyOffsets requires one duration and one pause for every segment",
    );
  }

  const shifted: WordTiming[] = [];
  let offset = 0;
  for (let index = 0; index < words.length; index += 1) {
    for (const word of words[index]) {
      shifted.push({
        word: word.word,
        startMs: word.startMs + offset,
        endMs: word.endMs + offset,
      });
    }
    offset += segmentDurationsMs[index] + pauseAfterMs[index];
  }
  return shifted;
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

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function buildPacingReport(args: {
  words: WordTiming[];
  durationMs: number;
  pausesMs: number[];
  targets: PacingTargets;
}): PacingReport {
  const { words, durationMs, pausesMs, targets } = args;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`Invalid durationMs: ${durationMs}`);
  }

  const totalWords = words.length;
  const wpmTotal = roundTo(totalWords / (durationMs / 60000), 1);

  let utteranceMs = 0;
  if (words.length > 0) {
    let utteranceStart = words[0].startMs;
    let previousEnd = words[0].endMs;
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index];
      if (word.startMs - previousEnd > PAUSE_GAP_MS) {
        utteranceMs += previousEnd - utteranceStart;
        utteranceStart = word.startMs;
      }
      previousEnd = word.endMs;
    }
    utteranceMs += previousEnd - utteranceStart;
  }
  const wpmSpoken =
    utteranceMs > 0 ? roundTo(totalWords / (utteranceMs / 60000), 1) : 0;

  const silenceMs = pausesMs.reduce((sum, pause) => sum + pause, 0);
  const silenceRatio = roundTo(silenceMs / durationMs, 4);
  const pauseCount = pausesMs.length;
  const pausesPerMinute = roundTo(
    pauseCount / (durationMs / 60000),
    1,
  );

  const pass: PacingPass = {
    wpmSpoken:
      Math.abs(wpmSpoken - targets.wpmSpoken) <=
      targets.wpmSpoken * DEFAULT_TOLERANCES.wpmRelative,
    wpmTotal:
      Math.abs(wpmTotal - targets.wpmTotal) <=
      targets.wpmTotal * DEFAULT_TOLERANCES.wpmRelative,
    silenceRatio:
      Math.abs(silenceRatio - targets.silenceRatio) <=
      DEFAULT_TOLERANCES.silenceRatio,
    pausesPerMinute:
      Math.abs(pausesPerMinute - targets.pausesPerMinute) <=
      DEFAULT_TOLERANCES.pausesPerMinute,
  };

  return {
    totalWords,
    durationMs,
    wpmTotal,
    wpmSpoken,
    silenceRatio,
    pauseCount,
    pausesPerMinute,
    pauseMedianMs: Math.round(median(pausesMs)),
    pauseP90Ms: Math.round(p90(pausesMs)),
    targets,
    tolerances: { ...DEFAULT_TOLERANCES },
    pass,
    passed: Object.values(pass).every(Boolean),
  };
}
