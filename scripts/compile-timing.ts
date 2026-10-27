import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Storyboard } from "../schemas/storyboard";
import { WordTimings } from "../schemas/words";
import {
  compileStoryboard,
  computeShotMetrics,
  inferAnchors,
} from "./pacing-compiler";
import { DEFAULT_STYLE_ID, loadStyle } from "./style";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  project: string;
  style: string;
  writeAnchors: boolean;
  baseline: string | null;
}

const usage = () => {
  console.log(
    "Usage: npm run compile-timing -- <project> [--style <id>] " +
      "[--write-anchors] [--baseline <git-ref>]",
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
    writeAnchors: false,
    baseline: null,
  };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--write-anchors") {
      options.writeAnchors = true;
      continue;
    }
    const value = args.shift();
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--style") options.style = value;
    else if (flag === "--baseline") {
      if (!/^[A-Za-z0-9_./-]+$/.test(value)) {
        throw new Error(`Invalid git ref: ${value}`);
      }
      options.baseline = value;
    } else throw new Error(`Unknown option: ${flag}`);
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

const readGitJson = (ref: string, file: string): unknown => {
  const relative = path.relative(ROOT, file);
  try {
    const raw = execFileSync("git", ["show", `${ref}:${relative}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${relative} at ${ref}: ${message}`);
  }
};

const withWordIds = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const data = raw as { words?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.words)) return raw;
  return {
    ...data,
    words: data.words.map((word, index) => ({
      ...word,
      id:
        typeof word.id === "string"
          ? word.id
          : `w${String(index + 1).padStart(4, "0")}`,
    })),
  };
};

const formatIssues = (
  label: string,
  issues: Array<{ path: PropertyKey[]; message: string }>,
) => {
  const details = issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  return `${label} is invalid:\n${details}`;
};

const writeJson = (file: string, value: unknown) => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const main = () => {
  const options = parseArgs();
  const style = loadStyle(options.style);
  const projectDir = path.join(ROOT, "projects", options.project);
  const storyboardFile = path.join(
    projectDir,
    "storyboard",
    "storyboard.json",
  );
  const wordsFile = path.join(projectDir, "voice", "words.json");
  const reportFile = path.join(
    projectDir,
    "storyboard",
    "timing-report.json",
  );
  if (!existsSync(storyboardFile)) throw new Error(`Missing ${storyboardFile}`);
  if (!existsSync(wordsFile)) throw new Error(`Missing ${wordsFile}`);

  const storyboardResult = Storyboard.safeParse(readJson(storyboardFile));
  if (!storyboardResult.success) {
    throw new Error(formatIssues("Storyboard", storyboardResult.error.issues));
  }
  const wordsResult = WordTimings.safeParse(readJson(wordsFile));
  if (!wordsResult.success) {
    throw new Error(formatIssues("Word timings", wordsResult.error.issues));
  }

  // A migration baseline is measured against its own narration timings, not
  // the newly generated audio, so the before/after comparison is meaningful.
  let baselineMetrics;
  if (options.baseline) {
    const baselineStoryboard = Storyboard.safeParse(
      readGitJson(options.baseline, storyboardFile),
    );
    if (!baselineStoryboard.success) {
      throw new Error(
        formatIssues("Baseline storyboard", baselineStoryboard.error.issues),
      );
    }
    const baselineWords = WordTimings.safeParse(
      withWordIds(readGitJson(options.baseline, wordsFile)),
    );
    if (!baselineWords.success) {
      throw new Error(
        formatIssues("Baseline word timings", baselineWords.error.issues),
      );
    }
    baselineMetrics = computeShotMetrics(
      baselineStoryboard.data.scenes,
      baselineWords.data.words,
      baselineWords.data.durationMs,
    );
  }

  let storyboard = storyboardResult.data;
  if (options.writeAnchors) {
    storyboard = inferAnchors(storyboard, wordsResult.data);
  }

  // Compile everything before touching the filesystem, so a failure cannot
  // leave a half-written storyboard or report.
  const compiled = compileStoryboard({
    storyboard,
    words: wordsResult.data,
    style,
  });
  if (baselineMetrics) compiled.report.before = baselineMetrics;
  const validated = Storyboard.safeParse(compiled.storyboard);
  if (!validated.success) {
    throw new Error(
      formatIssues("Compiled storyboard", validated.error.issues),
    );
  }

  writeJson(storyboardFile, validated.data);
  writeJson(reportFile, compiled.report);

  const report = compiled.report;
  console.log(
    `Compiled ${report.after.sceneCount} scenes for ` +
      `${(report.after.durationMs / 1000).toFixed(3)}s at ${report.settings.fps}fps`,
  );
  console.log(
    `Cuts/min ${report.after.cutsPerMinute}, median shot ` +
      `${report.after.medianShotMs} ms, sentence-end cuts ` +
      `${(report.after.cutOnSentenceEnd * 100).toFixed(0)}%, min shot ` +
      `${report.after.minShotMs} ms`,
  );
  if (options.baseline) {
    console.log(
      `Baseline ${options.baseline}: ${report.before.cutsPerMinute} cuts/min, ` +
        `median ${report.before.medianShotMs} ms, ` +
        `${(report.before.cutOnSentenceEnd * 100).toFixed(0)}% sentence-end cuts`,
    );
  }
  for (const boundary of report.boundaries) {
    console.log(
      `${boundary.sceneId} @ ${boundary.boundaryMs} ms: hold ` +
        `${boundary.holdEffectiveMs}/${boundary.holdRequestedMs} ms, ` +
        `gap ${boundary.gapMs} ms`,
    );
  }
  for (const warning of report.warnings) console.warn(`Warning: ${warning}`);
  console.log(`Wrote ${path.relative(ROOT, storyboardFile)}`);
  console.log(`Wrote ${path.relative(ROOT, reportFile)}`);
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAILED: ${message}`);
  process.exit(1);
}
