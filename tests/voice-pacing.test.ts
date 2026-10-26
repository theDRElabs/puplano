import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_CHARS,
  applyOffsets,
  buildPacingReport,
  planSegments,
  readParagraphs,
  validateSpeed,
  type PlanOptions,
  type WordTiming,
} from "../scripts/voice-pacing";
import { loadStyle } from "../scripts/style";

const baseOptions: PlanOptions = {
  maxChars: DEFAULT_MAX_CHARS,
  wpmSpoken: 150,
  silenceRatio: 0.12,
  sentencePauseMs: [400, 800],
  paragraphPauseMs: [800, 1400],
  tailMs: 500,
  seed: "test",
};

test("readParagraphs splits blank lines and normalizes whitespace", () => {
  const text = "  First sentence. Second?  \n\n\nThird paragraph!\n\n";
  assert.deepEqual(readParagraphs(text), [
    "First sentence. Second?",
    "Third paragraph!",
  ]);
});

test("planSegments preserves paragraph order and respects maxChars", () => {
  const paragraphs = readParagraphs(
    [
      "One short sentence. Another short one here.",
      "A third sentence follows. A fourth sentence closes the paragraph.",
    ].join("\n\n"),
  );
  const plan = planSegments(paragraphs, { ...baseOptions, maxChars: 40 });

  assert.ok(plan.segments.length >= 2);
  assert.equal(
    plan.segments.map((segment) => segment.text).join(" "),
    paragraphs.join(" "),
  );
  for (const segment of plan.segments) {
    assert.ok(
      segment.text.length <= 40,
      `segment exceeds maxChars: ${segment.text}`,
    );
    assert.ok(segment.pauseAfterMs >= 0);
    assert.ok(segment.words > 0);
  }
  assert.equal(plan.segments.at(-1)?.pauseAfterMs, 0);
  assert.equal(
    plan.segments.filter((segment) => segment.kind === "paragraph").length,
    2,
  );
});

test("pause allocation lands near the requested silence ratio and respects clamps", () => {
  const sentences = Array.from({ length: 8 }, (_, sentence) =>
    Array.from({ length: 15 }, (_, word) => `w${sentence}_${word}`).join(" ") + ".",
  );
  const paragraphs = [
    sentences.slice(0, 4).join(" "),
    sentences.slice(4).join(" "),
  ];
  const options: PlanOptions = {
    ...baseOptions,
    maxChars: 110,
  };
  const plan = planSegments(paragraphs, options);

  const totalWords = plan.segments.reduce((sum, segment) => sum + segment.words, 0);
  assert.equal(totalWords, 120);

  const pauseSum = plan.segments.reduce(
    (sum, segment) => sum + segment.pauseAfterMs,
    0,
  );
  const ratio = pauseSum / (plan.estimatedSpeechMs + pauseSum + plan.tailMs);
  assert.ok(
    Math.abs(ratio - 0.12) <= 0.03,
    `expected silence ratio near 0.12, got ${ratio}`,
  );

  for (const segment of plan.segments) {
    if (segment.pauseAfterMs === 0) continue;
    const [min, max] =
      segment.kind === "paragraph"
        ? options.paragraphPauseMs
        : options.sentencePauseMs;
    assert.ok(
      segment.pauseAfterMs >= min,
      `${segment.kind} pause below min: ${segment.pauseAfterMs}`,
    );
    assert.ok(
      segment.pauseAfterMs <= max * 2,
      `${segment.kind} pause above redistribution cap: ${segment.pauseAfterMs}`,
    );
  }

  const again = planSegments(paragraphs, options);
  assert.deepEqual(again, plan);
});

test("applyOffsets shifts each segment by preceding audio and pauses", () => {
  const words: WordTiming[][] = [
    [
      { word: "a", startMs: 0, endMs: 100 },
      { word: "b", startMs: 200, endMs: 300 },
    ],
    [{ word: "c", startMs: 0, endMs: 50 }],
    [{ word: "d", startMs: 10, endMs: 60 }],
  ];

  assert.deepEqual(applyOffsets(words, [1000, 500, 250], [300, 200, 0]), [
    { word: "a", startMs: 0, endMs: 100 },
    { word: "b", startMs: 200, endMs: 300 },
    { word: "c", startMs: 1300, endMs: 1350 },
    { word: "d", startMs: 2010, endMs: 2060 },
  ]);
});

test("buildPacingReport computes known WPM, silence, and pass flags", () => {
  const words: WordTiming[] = [
    { word: "a", startMs: 0, endMs: 500 },
    { word: "b", startMs: 600, endMs: 1000 },
    { word: "c", startMs: 2000, endMs: 2500 },
    { word: "d", startMs: 2600, endMs: 3000 },
    { word: "e", startMs: 4000, endMs: 4500 },
  ];
  const targets = {
    wpmSpoken: 120,
    wpmTotal: 60,
    silenceRatio: 0.4,
    pausesPerMinute: 24,
  };

  const report = buildPacingReport({
    words,
    durationMs: 5000,
    pausesMs: [1000, 1000],
    targets,
  });

  assert.equal(report.totalWords, 5);
  assert.equal(report.wpmTotal, 60);
  assert.equal(report.wpmSpoken, 120);
  assert.equal(report.silenceRatio, 0.4);
  assert.equal(report.pauseCount, 2);
  assert.equal(report.pausesPerMinute, 24);
  assert.equal(report.pauseMedianMs, 1000);
  assert.equal(report.pauseP90Ms, 1000);
  assert.equal(report.passed, true);

  const failed = buildPacingReport({
    words,
    durationMs: 5000,
    pausesMs: [1000, 1000],
    targets: { ...targets, wpmSpoken: 200 },
  });
  assert.equal(failed.pass.wpmSpoken, false);
  assert.equal(failed.passed, false);
});

test("invalid speed and missing style throw", () => {
  assert.throws(() => validateSpeed(0.5), /0\.7/);
  assert.throws(() => validateSpeed(1.3), /1\.2/);
  assert.throws(() => loadStyle("missing-style"), /not found/);
});
