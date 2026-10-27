import assert from "node:assert/strict";
import test from "node:test";
import { Storyboard } from "../schemas/storyboard";
import { WordTimings } from "../schemas/words";
import {
  compileStoryboard,
  computeShotMetrics,
  tokenize,
} from "../scripts/pacing-compiler";
import { assertBoundariesInGaps } from "../scripts/timing-guards";
import { loadStyle } from "../scripts/style";

const style = loadStyle("network-truecrime");

const word = (index: number, text: string, startMs: number, endMs: number) => ({
  id: `w${String(index).padStart(4, "0")}`,
  word: text,
  startMs,
  endMs,
});

const scene = (
  id: string,
  narration: string,
  anchor: { startWordId: string; endWordId: string },
  startMs: number,
  endMs: number,
  layout: number,
  holdMs?: number,
) => ({
  id,
  chapter: 1,
  startMs,
  endMs,
  layout,
  narration,
  anchor,
  ...(holdMs === undefined ? {} : { holdMs }),
  template: "kinetic_title" as const,
  props: { text: narration },
});

const storyboard = (
  scenes: ReturnType<typeof scene>[],
  durationMs: number,
  overlays: unknown[] = [],
) =>
  Storyboard.parse({
    title: "Compiler test",
    audioFile: "voice/narration.mp3",
    durationMs,
    scenes,
    overlays,
  });

const words = (items: ReturnType<typeof word>[], durationMs: number) =>
  WordTimings.parse({ voiceName: "Test", durationMs, words: items });

const frame = 1000 / 30;
const onFrame = (ms: number) =>
  Math.abs(ms - Math.round(ms / frame) * frame) < 1;

test("word ids are required, unique, and stable", () => {
  const missing = WordTimings.safeParse({
    voiceName: "Test",
    durationMs: 1000,
    words: [{ word: "One.", startMs: 0, endMs: 500 }],
  });
  assert.equal(missing.success, false);

  const duplicate = WordTimings.safeParse({
    voiceName: "Test",
    durationMs: 1000,
    words: [
      { id: "w0001", word: "One.", startMs: 0, endMs: 400 },
      { id: "w0001", word: "Two.", startMs: 500, endMs: 900 },
    ],
  });
  assert.equal(duplicate.success, false);

  const valid = WordTimings.safeParse({
    voiceName: "Test",
    durationMs: 1000,
    words: [
      { id: "w0001", word: "One.", startMs: 0, endMs: 400 },
      { id: "w0002", word: "Two.", startMs: 500, endMs: 900 },
    ],
  });
  assert.equal(valid.success, true);
});

test("narration tokenization matches numeric and a.m. words", () => {
  assert.deepEqual(
    tokenize("Heading west at exactly 1:44 a.m."),
    ["heading", "west", "at", "exactly", "1:44", "a.m"],
  );
  const timingWords = words(
    [
      word(1, "Heading", 0, 200),
      word(2, "west", 250, 450),
      word(3, "at", 500, 600),
      word(4, "exactly", 650, 900),
      word(5, "1:44", 950, 1500),
      word(6, "a.m.", 1550, 2000),
      word(7, "Next.", 2500, 2700),
    ],
    6000,
  );
  const result = compileStoryboard({
    storyboard: storyboard(
      [
        scene(
          "s1",
          "Heading west at exactly 1:44 a.m.",
          { startWordId: "w0001", endWordId: "w0006" },
          0,
          3000,
          1,
        ),
        scene(
          "s2",
          "Next.",
          { startWordId: "w0007", endWordId: "w0007" },
          3000,
          6000,
          2,
        ),
      ],
      6000,
    ),
    words: timingWords,
    style,
    options: { minShotMs: 100 },
  });
  assert.ok(result.storyboard.scenes[0].endMs > 2000);
});

test("a scene that ends mid-sentence is rejected by name", () => {
  const timingWords = words(
    [word(1, "Heading", 0, 300), word(2, "west", 400, 700)],
    2000,
  );
  const input = storyboard(
    [
      scene(
        "s6",
        "Heading west",
        { startWordId: "w0001", endWordId: "w0002" },
        0,
        1000,
        1,
      ),
      scene(
        "s7",
        "Done.",
        { startWordId: "w0002", endWordId: "w0002" },
        1000,
        2000,
        2,
      ),
    ],
    2000,
  );
  assert.throws(
    () =>
      compileStoryboard({
        storyboard: input,
        words: timingWords,
        style,
        options: { minShotMs: 100 },
      }),
    /scene s6 ends mid-sentence/,
  );
});

test("hold plus pad is quantized and clamped against the next word", () => {
  const timingWords = words(
    [word(1, "One.", 0, 1000), word(2, "Two.", 2000, 3000)],
    5000,
  );
  const input = storyboard(
    [
      scene(
        "s1",
        "One.",
        { startWordId: "w0001", endWordId: "w0001" },
        0,
        2500,
        1,
        300,
      ),
      scene(
        "s2",
        "Two.",
        { startWordId: "w0002", endWordId: "w0002" },
        2500,
        5000,
        2,
      ),
    ],
    5000,
  );
  const result = compileStoryboard({
    storyboard: input,
    words: timingWords,
    style,
    options: { minShotMs: 100 },
  });
  const boundary = result.storyboard.scenes[0].endMs;
  assert.ok(Math.abs(boundary - 1380) <= 34);
  assert.ok(onFrame(boundary));
  assert.equal(result.report.boundaries[0].holdRequestedMs, 300);
  assert.equal(result.report.boundaries[0].holdEffectiveMs, boundary - 1000 - 80);

  const clamped = compileStoryboard({
    storyboard: storyboard(
      [
        scene(
          "s1",
          "One.",
          { startWordId: "w0001", endWordId: "w0001" },
          0,
          2000,
          1,
          500,
        ),
        scene(
          "s2",
          "Two.",
          { startWordId: "w0002", endWordId: "w0002" },
          2000,
          4000,
          2,
        ),
      ],
      4000,
    ),
    words: words(
      [word(1, "One.", 0, 1000), word(2, "Two.", 1200, 2400)],
      4000,
    ),
    style,
    options: { minShotMs: 100 },
  });
  const clampBoundary = clamped.storyboard.scenes[0].endMs;
  assert.ok(clampBoundary >= 1000 + 34);
  assert.ok(clampBoundary <= 1200 - 34);
  assert.ok(onFrame(clampBoundary));
  assert.equal(clamped.report.boundaries[0].holdRequestedMs, 500);
  assert.ok(
    clamped.report.boundaries[0].holdEffectiveMs <
      clamped.report.boundaries[0].holdRequestedMs,
  );
});

test("boundary guard allows a gap and rejects a mid-word cut", () => {
  assert.doesNotThrow(() =>
    assertBoundariesInGaps(
      [
        { id: "s1", startMs: 0, endMs: 1200 },
        { id: "s2", startMs: 1200, endMs: 3000 },
      ],
      {
        durationMs: 3000,
        words: [
          { word: "a", startMs: 0, endMs: 1000 },
          { word: "b", startMs: 1500, endMs: 2500 },
        ],
      },
    ),
  );

  assert.throws(
    () =>
      assertBoundariesInGaps(
        [
          { id: "s1", startMs: 0, endMs: 1500 },
          { id: "s2", startMs: 1500, endMs: 3000 },
        ],
        {
          durationMs: 3000,
          words: [{ word: "hello", startMs: 1000, endMs: 1800 }],
        },
      ),
    /mid-word cut.*1500.*hello/s,
  );
});

test("a shot shorter than minShotMs is rejected with details", () => {
  const input = storyboard(
    [
      scene(
        "s1",
        "One.",
        { startWordId: "w0001", endWordId: "w0001" },
        0,
        500,
        1,
      ),
      scene(
        "s2",
        "Two.",
        { startWordId: "w0002", endWordId: "w0002" },
        500,
        1000,
        2,
      ),
    ],
    1000,
  );
  assert.throws(
    () =>
      compileStoryboard({
        storyboard: input,
        words: words(
          [word(1, "One.", 0, 100), word(2, "Two.", 300, 400)],
          1000,
        ),
        style,
        options: { minShotMs: 1600 },
      }),
    /shorter than minShotMs 1600/,
  );
});

test("overlay full, word, and scene anchors resolve from compiled timing", () => {
  const timingWords = words(
    [word(1, "One.", 0, 1000), word(2, "Two.", 2000, 3000)],
    5000,
  );
  const input = storyboard(
    [
      scene(
        "s1",
        "One.",
        { startWordId: "w0001", endWordId: "w0001" },
        0,
        2500,
        1,
      ),
      scene(
        "s2",
        "Two.",
        { startWordId: "w0002", endWordId: "w0002" },
        2500,
        5000,
        2,
      ),
    ],
    5000,
    [
      {
        id: "full",
        kind: "label",
        text: "Full",
        position: "top",
        span: "full",
      },
      {
        id: "word",
        kind: "lower_third",
        text: "Word",
        position: "bottom",
        anchor: { startWordId: "w0002", endWordId: "w0002" },
      },
      {
        id: "scene",
        kind: "source_caption",
        text: "Scene",
        position: "bottom",
        anchor: { startSceneId: "s1", endSceneId: "s1" },
      },
    ],
  );
  const result = compileStoryboard({
    storyboard: input,
    words: timingWords,
    style,
    options: { minShotMs: 100 },
  });
  const overlays = new Map(
    result.storyboard.overlays.map((overlay) => [overlay.id, overlay]),
  );
  assert.deepEqual(
    [overlays.get("full")!.startMs, overlays.get("full")!.endMs],
    [0, 5000],
  );
  assert.deepEqual(
    [overlays.get("word")!.startMs, overlays.get("word")!.endMs],
    [2000, 3000],
  );
  assert.deepEqual(
    [overlays.get("scene")!.startMs, overlays.get("scene")!.endMs],
    [0, result.storyboard.scenes[0].endMs],
  );
});

test("shot metrics and arcs use compiled ms", () => {
  const metricWords = [
    { word: "One.", startMs: 5000, endMs: 5600 },
    { word: "Two.", startMs: 11000, endMs: 11600 },
    { word: "Three.", startMs: 17000, endMs: 17600 },
    { word: "Four.", startMs: 23000, endMs: 23600 },
  ];
  const metricScenes = [
    { id: "s1", startMs: 0, endMs: 6000 },
    { id: "s2", startMs: 6000, endMs: 12000 },
    { id: "s3", startMs: 12000, endMs: 18000 },
    { id: "s4", startMs: 18000, endMs: 24000 },
  ];
  const metrics = computeShotMetrics(metricScenes, metricWords, 24000);
  assert.equal(metrics.cuts, 3);
  assert.equal(metrics.cutsPerMinute, 7.5);
  assert.equal(metrics.medianShotMs, 6000);
  assert.equal(metrics.p90ShotMs, 6000);
  assert.equal(metrics.longShotShare, 1);
  assert.equal(metrics.shortShotShare, 0);
  assert.equal(metrics.sentenceEndCuts, 3);
  assert.equal(metrics.cutOnSentenceEnd, 1);

  const arcWords = words(
    [
      word(1, "One.", 5000, 5600),
      word(2, "Two.", 11000, 11600),
      word(3, "Three.", 17000, 17600),
      word(4, "Four.", 23000, 23600),
    ],
    24000,
  );
  const arcInput = storyboard(
    [
      scene(
        "s1",
        "One.",
        { startWordId: "w0001", endWordId: "w0001" },
        0,
        6000,
        1,
      ),
      scene(
        "s2",
        "Two.",
        { startWordId: "w0002", endWordId: "w0002" },
        6000,
        12000,
        2,
      ),
      scene(
        "s3",
        "Three.",
        { startWordId: "w0003", endWordId: "w0003" },
        12000,
        18000,
        3,
      ),
      scene(
        "s4",
        "Four.",
        { startWordId: "w0004", endWordId: "w0004" },
        18000,
        24000,
        1,
      ),
    ],
    24000,
  );
  const result = compileStoryboard({
    storyboard: arcInput,
    words: arcWords,
    style,
    options: { minShotMs: 500 },
  });
  assert.equal(result.report.after.cutsPerMinute, 7.5);
  assert.equal(result.report.after.cutOnSentenceEnd, 1);
  assert.equal(result.report.arcs.length, 4);
  assert.deepEqual(
    result.report.arcs.map((arc) => arc.sceneCount),
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    result.report.arcs.map((arc) => arc.label),
    ["open_high", "mid_ease", "climax_accel", "resolve_hold"],
  );
  assert.equal(result.report.arcs[3].cuts, 0);
  assert.equal(result.report.arcs[3].pass, false);
});

test("an anchor that does not match narration throws", () => {
  const timingWords = words(
    [word(1, "Wrong.", 0, 300), word(2, "Done.", 400, 700)],
    2000,
  );
  const input = storyboard(
    [
      scene(
        "s1",
        "Different.",
        { startWordId: "w0001", endWordId: "w0001" },
        0,
        1000,
        1,
      ),
      scene(
        "s2",
        "Done.",
        { startWordId: "w0002", endWordId: "w0002" },
        1000,
        2000,
        2,
      ),
    ],
    2000,
  );
  assert.throws(
    () =>
      compileStoryboard({
        storyboard: input,
        words: timingWords,
        style,
        options: { minShotMs: 100 },
      }),
    /scene s1: anchor .* resolves to "wrong" but narration is "different"/,
  );
});
