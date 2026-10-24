import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Storyboard } from "../schemas/storyboard";
import { WordTimings } from "../schemas/words";
import { stageProjectAssets } from "./project-assets";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Options = {
  project: string;
  output?: string;
  scale: number;
};

const usage = () => {
  console.log(
    "Usage: npm run render -- <project> [--output <file.mp4>] [--scale <number>]",
  );
};

const parseArgs = (): Options => {
  const args = process.argv.slice(2);
  const project = args.shift();
  if (!project || project.startsWith("-")) {
    usage();
    process.exit(1);
  }

  const options: Options = { project, scale: 1 };
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--output") options.output = value;
    else if (flag === "--scale") options.scale = Number(value);
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (!Number.isFinite(options.scale) || options.scale < 0.1 || options.scale > 2) {
    throw new Error("--scale must be a number from 0.1 to 2");
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

const formatIssues = (
  label: string,
  issues: Array<{ path: PropertyKey[]; message: string }>,
) => {
  const details = issues
    .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  return `${label} is invalid:\n${details}`;
};

const assertSceneBoundaries = (
  storyboard: ReturnType<typeof Storyboard.parse>,
  timings: ReturnType<typeof WordTimings.parse>,
) => {
  const boundaries = new Set<number>([0, timings.durationMs]);
  timings.words.forEach((word) => {
    boundaries.add(word.startMs);
    boundaries.add(word.endMs);
  });

  storyboard.scenes.forEach((scene) => {
    if (!boundaries.has(scene.startMs) || !boundaries.has(scene.endMs)) {
      throw new Error(
        `Scene ${scene.id} must start and end on word boundaries (${scene.startMs}-${scene.endMs} ms)`,
      );
    }
  });
};

const main = () => {
  const options = parseArgs();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.project)) {
    throw new Error(`Invalid project name: ${options.project}`);
  }

  const projectDir = path.join(ROOT, "projects", options.project);
  const storyboardFile = path.join(projectDir, "storyboard", "storyboard.json");
  const wordsFile = path.join(projectDir, "voice", "words.json");
  if (!existsSync(storyboardFile)) throw new Error(`Missing ${storyboardFile}`);
  if (!existsSync(wordsFile)) throw new Error(`Missing ${wordsFile}`);

  console.log("1/4 Validating storyboard and word timings");
  const storyboardResult = Storyboard.safeParse(readJson(storyboardFile));
  if (!storyboardResult.success) {
    throw new Error(formatIssues("Storyboard", storyboardResult.error.issues));
  }
  const wordsResult = WordTimings.safeParse(readJson(wordsFile));
  if (!wordsResult.success) {
    throw new Error(formatIssues("Word timings", wordsResult.error.issues));
  }
  if (storyboardResult.data.durationMs !== wordsResult.data.durationMs) {
    throw new Error(
      `Duration mismatch: storyboard is ${storyboardResult.data.durationMs} ms, audio is ${wordsResult.data.durationMs} ms`,
    );
  }
  assertSceneBoundaries(storyboardResult.data, wordsResult.data);

  console.log("2/4 Checking storyboard numbers against the script");
  execFileSync("python3", [path.join(ROOT, "scripts", "check-numbers.py"), options.project], {
    cwd: ROOT,
    stdio: "inherit",
  });

  console.log("3/4 Staging project assets");
  const staged = stageProjectAssets({
    root: ROOT,
    project: options.project,
    storyboard: storyboardResult.data,
  });
  staged.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));

  const output = path.resolve(
    ROOT,
    options.output ?? path.join("projects", options.project, "renders", "final.mp4"),
  );
  mkdirSync(path.dirname(output), { recursive: true });

  const temporaryDir = mkdtempSync(path.join(tmpdir(), "puplano-render-"));
  const propsFile = path.join(temporaryDir, "props.json");
  try {
    writeFileSync(
      propsFile,
      JSON.stringify({ ...staged.storyboard, words: wordsResult.data.words }),
    );

    const remotionDir = path.join(ROOT, "remotion");
    const remotionBin = path.join(
      remotionDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "remotion.cmd" : "remotion",
    );
    if (!existsSync(remotionBin)) {
      throw new Error("Remotion is not installed. Run: npm install --prefix remotion");
    }

    console.log(`4/4 Rendering ${path.relative(ROOT, output)}`);
    execFileSync(
      remotionBin,
      [
        "render",
        "src/index.ts",
        "StoryboardVideo",
        output,
        "--props",
        propsFile,
        "--codec",
        "h264",
        "--audio-codec",
        "aac",
        "--scale",
        String(options.scale),
        "--log",
        "warn",
        "--overwrite",
      ],
      { cwd: remotionDir, stdio: "inherit" },
    );
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }

  console.log(`Done: ${output}`);
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAILED: ${message}`);
  process.exit(1);
}
