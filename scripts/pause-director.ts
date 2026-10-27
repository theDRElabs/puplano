import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PauseDirection,
  type DirectedPause,
  type PauseKind,
} from "../schemas/pause-direction";
import { WordTimings } from "../schemas/words";
import { DEFAULT_STYLE_ID, loadStyle } from "./style";
import { readParagraphs, readSentences } from "./voice-pacing";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  project: string;
  style: string;
  write: boolean;
}

interface SceneEnd {
  sentence: number;
  sceneId: string;
}

interface Unit {
  index: number;
  paragraph: number;
  text: string;
  wordCount: number;
  firstWordId: string;
  lastWordId: string;
  startMs: number;
  endMs: number;
  isParagraphEnd: boolean;
  sceneId: string | null;
}

const usage = () => {
  console.log(
    "Usage: npm run direct-pauses -- <project> [--style <id>] [--write]",
  );
};

const parseArgs = (): Options => {
  const args = process.argv.slice(2);
  const project = args.shift();
  if (!project || project.startsWith("-")) {
    usage();
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) {
    throw new Error(`Invalid project name: ${project}`);
  }
  const options: Options = {
    project,
    style: DEFAULT_STYLE_ID,
    write: false,
  };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--write") {
      options.write = true;
      continue;
    }
    const value = args.shift();
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--style") options.style = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${path.relative(ROOT, file)}: ${message}`);
  }
};

const readScript = (file: string): string =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();

const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const sceneEndsBySentence = (
  storyboardFile: string,
  sentenceByWordId: Map<string, number>,
): Map<number, string> => {
  const raw = readJson(storyboardFile) as {
    scenes?: Array<{ id?: string; anchor?: { endWordId?: string } }>;
  };
  const result = new Map<number, string>();
  for (const scene of raw.scenes ?? []) {
    const endWordId = scene.anchor?.endWordId;
    if (!endWordId || !scene.id) continue;
    const sentence = sentenceByWordId.get(endWordId);
    if (sentence !== undefined) result.set(sentence, scene.id);
  }
  return result;
};

const buildUnits = (
  script: string,
  words: Array<{
    id: string;
    word: string;
    startMs: number;
    endMs: number;
  }>,
  sceneEnds: Map<number, string>,
): Unit[] => {
  const sentences = readSentences(readParagraphs(script));
  if (sentences.length === 0) throw new Error("Script has no sentences");
  const units: Unit[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const slice = words.slice(cursor, cursor + sentence.wordCount);
    if (slice.length !== sentence.wordCount) {
      throw new Error(
        `Sentence ${sentence.index} needs ${sentence.wordCount} words; ` +
          `only ${slice.length} remain`,
      );
    }
    const joined = slice.map((word) => word.word).join(" ");
    if (joined !== sentence.text) {
      throw new Error(
        `Sentence ${sentence.index} does not match word timings:\n` +
          `  script: ${sentence.text}\n  words:  ${joined}`,
      );
    }
    units.push({
      index: sentence.index,
      paragraph: sentence.paragraph,
      text: sentence.text,
      wordCount: sentence.wordCount,
      firstWordId: slice[0].id,
      lastWordId: slice[slice.length - 1].id,
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      isParagraphEnd: sentence.isParagraphEnd,
      sceneId: sceneEnds.get(sentence.index) ?? null,
    });
    cursor += sentence.wordCount;
  }
  if (cursor !== words.length) {
    throw new Error(
      `Script consumed ${cursor} words but words.json has ${words.length}`,
    );
  }
  return units;
};

const REVEAL =
  /\b(scarf|never seen again|time of death|not everything|watching|no known enemies|went cold|precinct|missing|nothing)\b/i;
const TIME_CLOSE = /(?:a\.m\.|p\.m\.|midnight|night\.)$/i;

interface Score {
  unit: Unit;
  score: number;
  reasons: string[];
}

export const scoreUnit = (unit: Unit, units: Unit[]): Score => {
  let score = 0;
  const reasons: string[] = [];
  if (unit.isParagraphEnd) {
    score += 50;
    reasons.push("paragraph close");
  }
  if (unit.sceneId) {
    score += 20;
    reasons.push(`scene cut ${unit.sceneId}`);
  }
  if (TIME_CLOSE.test(unit.text)) {
    score += 30;
    reasons.push("time stamp lands");
  }
  if (REVEAL.test(unit.text)) {
    score += 30;
    reasons.push("reveal word");
  }
  if (unit.wordCount <= 4) {
    score += 10;
    reasons.push("short punch");
  }
  if (unit.paragraph === 1 && unit.isParagraphEnd) {
    score += 10;
    reasons.push("opening hook");
  }
  if (unit.index === units.length) {
    score -= 100;
    reasons.push("final line");
  }
  if (unit.index === units.length - 1) {
    score += 45;
    reasons.push("sets up final line");
  }
  const next = units[unit.index];
  if (next) {
    if (/^(No|And|But|Just)\b/i.test(next.text)) {
      score -= 30;
      reasons.push("next sentence continues a list");
    }
    if (/^(She|He|It|They)\b/i.test(next.text) && unit.wordCount <= 5) {
      score -= 25;
      reasons.push("short setup before action");
    }
    if (/^A man\b/i.test(next.text)) {
      score -= 15;
      reasons.push("next sentence continues the anaphora");
    }
  }
  return { unit, score, reasons };
};

const selectScored = (scored: Score[]): Score[] => {
  const eligible = scored
    .filter((entry) => entry.unit.index !== scored.length)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.unit.index - right.unit.index;
    });
  const selected: Score[] = [];
  const minScore = 45;
  for (const entry of eligible) {
    if (entry.score < minScore) continue;
    if (selected.length >= 11) break;
    selected.push(entry);
  }
  for (const entry of eligible) {
    if (selected.length >= 8) break;
    if (selected.some((item) => item.unit.index === entry.unit.index)) continue;
    selected.push(entry);
  }
  return selected.sort((left, right) => left.unit.index - right.unit.index);
};

const gapFor = (entry: Score, units: Unit[]): number => {
  let gap = entry.score >= 90 ? 900 : entry.score >= 60 ? 900 : entry.score >= 50 ? 500 : 400;
  if (entry.unit.paragraph === 1 && entry.unit.isParagraphEnd) gap = 1000;
  if (entry.unit.index === units.length - 1) gap = 800;
  if (
    entry.unit.paragraph <= 2 &&
    !(entry.unit.paragraph === 1 && entry.unit.isParagraphEnd)
  ) {
    gap = Math.min(gap, 650);
  }
  return Math.min(1200, Math.max(350, gap));
};

const kindFor = (entry: Score, units: Unit[]): PauseKind => {
  if (entry.unit.isParagraphEnd && entry.unit.sceneId) return "act-break";
  if (entry.unit.isParagraphEnd) return "paragraph-break";
  if (entry.unit.sceneId) return "beat";
  if (entry.unit.index === units.length - 1) return "reveal";
  return entry.score >= 90 ? "reveal" : "breath";
};

const reasonFor = (entry: Score): string => {
  const detail = entry.reasons.length > 0 ? entry.reasons.join("; ") : "editorial beat";
  return `${detail}; ${entry.unit.text}`;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
};

const main = () => {
  const options = parseArgs();
  const style = loadStyle(options.style);
  const projectDir = path.join(ROOT, "projects", options.project);
  const scriptFile = path.join(projectDir, "script", "script.md");
  const wordsFile = path.join(projectDir, "voice", "words.json");
  const storyboardFile = path.join(projectDir, "storyboard", "storyboard.json");
  for (const file of [scriptFile, wordsFile, storyboardFile]) {
    if (!existsSync(file)) throw new Error(`Missing ${file}`);
  }
  const script = readScript(scriptFile);
  const wordsResult = WordTimings.safeParse(readJson(wordsFile));
  if (!wordsResult.success) {
    const issues = wordsResult.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Word timings are invalid:\n${issues}`);
  }
  const words = wordsResult.data.words;
  const sentenceByWordId = new Map<string, number>();
  const sentenceUnits = readSentences(readParagraphs(script));
  let wordCursor = 0;
  for (const sentence of sentenceUnits) {
    sentenceByWordId.set(words[wordCursor + sentence.wordCount - 1].id, sentence.index);
    wordCursor += sentence.wordCount;
  }
  const units = buildUnits(
    script,
    words,
    sceneEndsBySentence(storyboardFile, sentenceByWordId),
  );
  const scored = units.map((unit) => scoreUnit(unit, units));
  const selected = selectScored(scored);

  const pauses: DirectedPause[] = selected.map((entry) => {
    const targetGapMs = gapFor(entry, units);
    const kind = kindFor(entry, units);
    return {
      afterSentence: entry.unit.index,
      afterWordId: entry.unit.lastWordId,
      afterText: entry.unit.text,
      targetGapMs,
      kind,
      reason: reasonFor(entry),
    };
  });

  const direction = {
    version: 1 as const,
    generatedBy: "scripts/pause-director.ts",
    sourceHash: hash(script),
    pauses,
    metrics: {
      sentenceCount: units.length,
      pauseCount: pauses.length,
      totalPauseMs: pauses.reduce((sum, pause) => sum + pause.targetGapMs, 0),
      medianGapMs: median(pauses.map((pause) => pause.targetGapMs)),
      longBeats: pauses.filter((pause) => pause.targetGapMs >= 900).length,
    },
  };
  const validated = PauseDirection.safeParse(direction);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Pause direction is invalid:\n${issues}`);
  }

  console.log(
    `${units.length} sentences, ${pauses.length} directed pauses, ` +
      `${direction.metrics.totalPauseMs}ms total, median ` +
      `${direction.metrics.medianGapMs}ms, ` +
      `${direction.metrics.longBeats} long beat(s)`,
  );
  for (const pause of pauses) {
    console.log(
      `${pause.afterWordId} ${String(pause.targetGapMs).padStart(4)}ms ` +
        `${pause.kind.padEnd(15)} ${pause.afterText.slice(0, 72)}`,
    );
  }

  if (!options.write) {
    console.log(JSON.stringify(validated.data, null, 2));
    return;
  }
  const voiceDir = path.join(projectDir, "voice");
  mkdirSync(voiceDir, { recursive: true });
  const outFile = path.join(voiceDir, "pause-direction.json");
  writeFileSync(outFile, `${JSON.stringify(validated.data, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, outFile)}`);
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAILED: ${message}`);
  process.exit(1);
}
