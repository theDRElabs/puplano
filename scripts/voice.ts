import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_STYLE_ID, loadStyle } from "./style";
import {
  PAUSE_GAP_MS,
  applyOffsets,
  buildPacingReport,
  planSegments,
  readParagraphs,
  validateSpeed,
  type PacingTargets,
  type SegmentPlan,
  type WordTiming,
} from "./voice-pacing";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.elevenlabs.io/v1";
const SEGMENT_MAX_CHARS = 150;
const TAIL_MS = 750;
const SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;

interface Config {
  voiceName: string;
  modelId: string;
  maxChunkChars?: number;
  speed?: number;
}

interface Cli {
  project: string;
  styleId: string;
  speed?: number;
  dryRun: boolean;
  strict: boolean;
}

interface SynthesisResult {
  words: WordTiming[];
  durationMs: number;
}

const USAGE =
  "Usage: npm run voice -- <project> [--style <id>] [--speed <n>] [--dry-run] [--strict]";

function parseCli(argv: string[]): Cli {
  const args = argv.slice(2);
  const project = args[0];
  if (!project || project.startsWith("--")) {
    throw new Error(`Missing project.\n${USAGE}`);
  }

  let styleId = DEFAULT_STYLE_ID;
  let speed: number | undefined;
  let dryRun = false;
  let strict = false;

  const valueAfter = (index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--style") {
      styleId = valueAfter(index, argument);
      index += 1;
    } else if (argument.startsWith("--style=")) {
      styleId = argument.slice("--style=".length);
    } else if (argument === "--speed") {
      speed = Number(valueAfter(index, argument));
      index += 1;
    } else if (argument.startsWith("--speed=")) {
      speed = Number(argument.slice("--speed=".length));
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--strict") {
      strict = true;
    } else {
      throw new Error(`Unknown option: ${argument}\n${USAGE}`);
    }
  }

  if (!styleId) throw new Error(`--style requires a value\n${USAGE}`);
  return { project, styleId, speed, dryRun, strict };
}

function loadKey(name: string): string {
  const text = readFileSync(
    path.join(homedir(), ".secrets", "pipeline.env"),
    "utf8",
  );
  const line = text.split("\n").find((entry) => entry.startsWith(name + "="));
  const value = line ? line.slice(name.length + 1).trim() : "";
  if (!value) throw new Error(`${name} is empty in ~/.secrets/pipeline.env`);
  return value;
}

async function findVoiceId(key: string, name: string): Promise<string> {
  const response = await fetch(`${API}/voices`, {
    headers: { "xi-api-key": key },
  });
  if (!response.ok) {
    throw new Error(`Could not list voices: HTTP ${response.status}`);
  }
  const data: any = await response.json();
  const match = data.voices?.find(
    (voice: any) =>
      voice.name.split(" - ")[0].toLowerCase() === name.toLowerCase(),
  );
  if (!match) throw new Error(`No voice named "${name}" on this account`);
  return match.voice_id;
}

function readScript(projectDir: string): string {
  const file = path.join(projectDir, "script", "script.md");
  if (!existsSync(file)) throw new Error(`Missing ${file}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();
}

function probeDurationMs(file: string): number {
  const probe = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const duration = Number(probe.toString().trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read duration for ${path.basename(file)}`);
  }
  return Math.round(duration * 1000);
}

function wordsFromAlignment(alignment: any): WordTiming[] {
  const characters = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    characters.length !== starts.length ||
    characters.length !== ends.length
  ) {
    throw new Error("ElevenLabs returned malformed timing data");
  }

  const words: WordTiming[] = [];
  let current = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (!current) return;
    words.push({
      word: current,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
    });
    current = "";
  };

  characters.forEach((character: string, index: number) => {
    if (/\s/.test(character)) {
      flush();
      return;
    }
    if (!current) start = starts[index];
    current += character;
    end = ends[index];
  });
  flush();
  return words;
}

function cacheKeyFor(
  text: string,
  voiceName: string,
  modelId: string,
  speed: number,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ text, voiceName, modelId, speed }))
    .digest("hex");
}

async function speakSegment(
  key: string,
  voiceId: string,
  modelId: string,
  text: string,
  previousText: string,
  nextText: string,
  speed: number,
  outFile: string,
): Promise<SynthesisResult> {
  const body: any = {
    text,
    model_id: modelId,
    voice_settings: { speed },
  };
  if (previousText) body.previous_text = previousText;
  if (nextText) body.next_text = nextText;

  const response = await fetch(
    `${API}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `ElevenLabs error HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }

  const data: any = await response.json();
  if (!data.alignment || !data.audio_base64) {
    throw new Error("ElevenLabs returned no audio or timing data");
  }
  writeFileSync(outFile, Buffer.from(data.audio_base64, "base64"));
  return {
    words: wordsFromAlignment(data.alignment),
    durationMs: probeDurationMs(outFile),
  };
}

function writeSilenceWav(file: string, durationMs: number): void {
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${SAMPLE_RATE}:cl=stereo`,
    "-t",
    (durationMs / 1000).toFixed(3),
    "-c:a",
    "pcm_s16le",
    file,
  ]);
}

function decodeToWav(input: string, output: string): void {
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    input,
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    String(AUDIO_CHANNELS),
    "-c:a",
    "pcm_s16le",
    output,
  ]);
}

function detectPauses(words: WordTiming[]): number[] {
  const pauses: number[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const gap = words[index].startMs - words[index - 1].endMs;
    if (gap > PAUSE_GAP_MS) pauses.push(gap);
  }
  return pauses;
}

function cleanupVoiceDir(voiceDir: string, segmentCount: number): void {
  const keep = new Set(
    Array.from({ length: segmentCount }, (_, index) =>
      `seg-${String(index + 1).padStart(3, "0")}`,
    ),
  );

  for (const file of readdirSync(voiceDir)) {
    const isSegment = file.startsWith("seg-");
    const base = file.replace(/\.(mp3|json|wav)$/, "");
    if (file.startsWith("chunk-")) {
      rmSync(path.join(voiceDir, file), { force: true });
      continue;
    }
    if (isSegment && !keep.has(base)) {
      rmSync(path.join(voiceDir, file), { force: true });
      continue;
    }
    if (
      file.endsWith(".wav") ||
      file === "concat.txt" ||
      file === "concat-wav.txt"
    ) {
      rmSync(path.join(voiceDir, file), { force: true });
    }
  }
}

function planForStyle(
  paragraphs: string[],
  style: ReturnType<typeof loadStyle>,
  speed: number,
): SegmentPlan {
  return planSegments(paragraphs, {
    maxChars: SEGMENT_MAX_CHARS,
    wpmSpoken: style.pacing.wpmSpoken,
    silenceRatio: style.pacing.silenceRatio,
    sentencePauseMs: [
      style.pacing.sentenceMinMs,
      style.pacing.sentenceMaxMs,
    ],
    paragraphPauseMs: [
      style.pacing.sentenceMaxMs,
      Math.max(style.pacing.sentenceMaxMs, style.pacing.pauseP90Ms),
    ],
    tailMs: TAIL_MS,
    seed: `${style.id}:${speed}`,
  });
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv);
  const config = JSON.parse(
    readFileSync(path.join(ROOT, "config.json"), "utf8"),
  ) as Config;
  if (!config.voiceName || !config.modelId) {
    throw new Error("config.json must set voiceName and modelId");
  }

  const speed = validateSpeed(cli.speed ?? config.speed ?? 1);
  const style = loadStyle(cli.styleId);
  const targets: PacingTargets = {
    wpmSpoken: style.pacing.wpmSpoken,
    wpmTotal: style.pacing.wpmTotal,
    silenceRatio: style.pacing.silenceRatio,
    pausesPerMinute: style.pacing.pausesPerMinute,
  };

  const projectDir = path.join(ROOT, "projects", cli.project);
  const voiceDir = path.join(projectDir, "voice");
  const script = readScript(projectDir);
  const paragraphs = readParagraphs(script);
  if (paragraphs.length === 0) {
    throw new Error(`No narration text in ${path.join(projectDir, "script", "script.md")}`);
  }

  const plan = planForStyle(paragraphs, style, speed);
  mkdirSync(voiceDir, { recursive: true });

  const plannedWords = plan.segments.reduce(
    (sum, segment) => sum + segment.words,
    0,
  );
  const plannedPauseMs = plan.segments.reduce(
    (sum, segment) => sum + segment.pauseAfterMs,
    0,
  );
  const plannedPauses = plan.segments
    .map((segment) => segment.pauseAfterMs)
    .filter((pauseMs) => pauseMs > 0);
  const estimatedSilenceRatio =
    plannedPauseMs /
    (plan.estimatedSpeechMs + plannedPauseMs + plan.tailMs);
  const estimated = {
    durationMs: plan.estimatedTotalMs,
    wpmSpoken: Number(
      (plannedWords / (plan.estimatedSpeechMs / 60000)).toFixed(1),
    ),
    wpmTotal: Number(
      (plannedWords / (plan.estimatedTotalMs / 60000)).toFixed(1),
    ),
    silenceRatio: Number(estimatedSilenceRatio.toFixed(4)),
    pauseCount: plannedPauses.length,
    pausesPerMinute: Number(
      (plannedPauses.length / (plan.estimatedTotalMs / 60000)).toFixed(1),
    ),
  };
  const planArtifact = {
    styleId: style.id,
    speed,
    targets,
    estimated,
    ...plan,
    estimatedSilenceRatio,
  };

  if (cli.dryRun) {
    const planPath = path.join(voiceDir, "pacing-plan.json");
    writeFileSync(planPath, JSON.stringify(planArtifact, null, 2));
    console.log(
      `Pacing plan: ${plan.segments.length} segment(s), ` +
        `pause budget ${plan.pauseBudgetMs}ms, ` +
        `estimated ${(plan.estimatedTotalMs / 1000).toFixed(1)}s, ` +
        `silence ${(estimatedSilenceRatio * 100).toFixed(1)}%`,
    );
    console.log(`Wrote ${planPath}`);
    return;
  }

  const key = loadKey("ELEVENLABS_API_KEY");
  const voiceId = await findVoiceId(key, config.voiceName);
  console.log(
    `Script: ${script.length} characters, ${plan.segments.length} segment(s), ` +
      `speed ${speed}, style ${style.id}`,
  );

  const segmentWords: WordTiming[][] = [];
  for (let index = 0; index < plan.segments.length; index += 1) {
    const segment = plan.segments[index];
    const number = String(index + 1).padStart(3, "0");
    const audio = path.join(voiceDir, `seg-${number}.mp3`);
    const meta = path.join(voiceDir, `seg-${number}.json`);
    const cacheKey = cacheKeyFor(
      segment.text,
      config.voiceName,
      config.modelId,
      speed,
    );
    let result: SynthesisResult | null = null;

    if (existsSync(audio) && existsSync(meta)) {
      try {
        const cached = JSON.parse(readFileSync(meta, "utf8"));
        if (
          cached.cacheKey === cacheKey &&
          cached.text === segment.text &&
          cached.voiceName === config.voiceName &&
          cached.modelId === config.modelId &&
          cached.speed === speed &&
          Array.isArray(cached.result?.words)
        ) {
          result = cached.result as SynthesisResult;
        }
      } catch {
        result = null;
      }
    }

    if (result) {
      console.log(
        `Segment ${index + 1}/${plan.segments.length}: reusing saved audio`,
      );
    } else {
      const previous =
        index > 0 ? plan.segments[index - 1].text.slice(-300) : "";
      const next =
        index < plan.segments.length - 1
          ? plan.segments[index + 1].text.slice(0, 300)
          : "";
      console.log(
        `Segment ${index + 1}/${plan.segments.length}: generating ` +
          `(${segment.words} words, ${segment.text.length} characters)`,
      );
      result = await speakSegment(
        key,
        voiceId,
        config.modelId,
        segment.text,
        previous,
        next,
        speed,
        audio,
      );
      writeFileSync(
        meta,
        JSON.stringify(
          {
            cacheKey,
            text: segment.text,
            voiceName: config.voiceName,
            modelId: config.modelId,
            speed,
            result,
          },
          null,
          2,
        ),
      );
    }
    segmentWords.push(result.words);
  }

  const concatFiles: string[] = [];
  const segmentDurationsMs: number[] = [];
  for (let index = 0; index < plan.segments.length; index += 1) {
    const number = String(index + 1).padStart(3, "0");
    const audio = path.join(voiceDir, `seg-${number}.mp3`);
    const wav = path.join(voiceDir, `seg-${number}.wav`);
    decodeToWav(audio, wav);
    segmentDurationsMs.push(probeDurationMs(wav));
    concatFiles.push(wav);

    if (index < plan.segments.length - 1) {
      const pauseMs = plan.segments[index].pauseAfterMs;
      if (pauseMs > 0) {
        const silence = path.join(voiceDir, `silence-${number}.wav`);
        writeSilenceWav(silence, pauseMs);
        concatFiles.push(silence);
      }
    }
  }

  const tailWav = path.join(voiceDir, "silence-tail.wav");
  writeSilenceWav(tailWav, plan.tailMs);
  concatFiles.push(tailWav);

  const concatList = path.join(voiceDir, "concat-wav.txt");
  writeFileSync(
    concatList,
    concatFiles
      .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
      .join("\n") + "\n",
  );

  const master = path.join(voiceDir, "master.wav");
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c:a",
    "pcm_s16le",
    master,
  ]);

  const narration = path.join(voiceDir, "narration.mp3");
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    master,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    narration,
  ]);

  const durationMs = probeDurationMs(narration);
  const pauses = plan.segments.map((segment) => segment.pauseAfterMs);
  const shifted = applyOffsets(segmentWords, segmentDurationsMs, pauses);
  const words = shifted.map((word) => {
    const endMs = Math.min(word.endMs, durationMs);
    return {
      word: word.word,
      startMs: word.startMs,
      endMs: Math.max(endMs, word.startMs + 1),
    };
  });
  const bad = words.find(
    (word) =>
      word.startMs >= durationMs ||
      word.endMs > durationMs ||
      word.endMs <= word.startMs,
  );
  if (bad) {
    throw new Error(
      `Word timing for "${bad.word}" runs outside the final audio duration`,
    );
  }

  writeFileSync(
    path.join(voiceDir, "words.json"),
    JSON.stringify(
      { voiceName: config.voiceName, durationMs, words },
      null,
      2,
    ),
  );

  const detectedPauses = detectPauses(words);
  const report = buildPacingReport({
    words,
    durationMs,
    pausesMs: detectedPauses,
    targets,
  });

  const reportArtifact = {
    styleId: style.id,
    speed,
    targets,
    actuals: {
      totalWords: report.totalWords,
      durationMs: report.durationMs,
      wpmTotal: report.wpmTotal,
      wpmSpoken: report.wpmSpoken,
      silenceRatio: report.silenceRatio,
      pauseCount: report.pauseCount,
      pausesPerMinute: report.pausesPerMinute,
      pauseMedianMs: report.pauseMedianMs,
      pauseP90Ms: report.pauseP90Ms,
    },
    tolerances: report.tolerances,
    pass: report.pass,
    passed: report.passed,
    estimated,
    plan: {
      pauseBudgetMs: plan.pauseBudgetMs,
      tailMs: plan.tailMs,
      estimatedSpeechMs: plan.estimatedSpeechMs,
      estimatedTotalMs: plan.estimatedTotalMs,
      estimatedSilenceRatio,
      segments: plan.segments.map((segment, index) => ({
        index: index + 1,
        text: segment.text,
        kind: segment.kind,
        words: segment.words,
        pauseAfterMs: segment.pauseAfterMs,
      })),
    },
  };
  writeFileSync(
    path.join(voiceDir, "pacing-report.json"),
    JSON.stringify(reportArtifact, null, 2),
  );

  cleanupVoiceDir(voiceDir, plan.segments.length);

  console.log(
    `Done: ${report.totalWords} words, ${(durationMs / 1000).toFixed(1)}s, ` +
      `${report.wpmTotal} wpm total, ${report.wpmSpoken} wpm spoken, ` +
      `silence ${(report.silenceRatio * 100).toFixed(1)}%, ` +
      `${report.pauseCount} pauses (${report.pausesPerMinute}/min), ` +
      `median ${report.pauseMedianMs}ms, p90 ${report.pauseP90Ms}ms`,
  );
  console.log(`Audio: ${narration}`);

  const failedTargets = Object.entries(report.pass)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedTargets.length > 0) {
    console.warn(`Pacing warnings: ${failedTargets.join(", ")} outside target`);
  } else {
    console.log("Pacing targets met");
  }

  if (cli.strict && !report.passed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("FAILED:", message);
  process.exit(1);
});
