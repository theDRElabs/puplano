import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PauseDirection } from "../schemas/pause-direction";
import { WordTimings } from "../schemas/words";
import {
  planDirectedSegments,
  readParagraphs,
  readSentences,
} from "../scripts/voice-pacing";

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf8"));

const readScript = (): string =>
  readFileSync("projects/truecrime/script/script.md", "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();

test("directed planning groups only around the chosen sentences", () => {
  const paragraphs = readParagraphs("One. Two. Three. Four.");
  const plan = planDirectedSegments(
    paragraphs,
    [{ afterSentence: 2, targetGapMs: 650 }],
    { maxChars: 100, wpmSpoken: 150, tailMs: 500 },
  );

  assert.equal(plan.segments.length, 2);
  assert.equal(plan.segments[0].text, "One. Two.");
  assert.equal(plan.segments[0].kind, "directed");
  assert.equal(plan.segments[0].pauseAfterMs, 650);
  assert.equal(plan.segments[1].text, "Three. Four.");
  assert.equal(plan.segments[1].kind, "continuous");
  assert.equal(plan.segments[1].pauseAfterMs, 0);
  assert.equal(plan.pauseBudgetMs, 650);
  assert.equal(
    plan.segments.map((segment) => segment.text).join(" "),
    "One. Two. Three. Four.",
  );
});

test("directed planning rejects out-of-range, duplicate, and negative pauses", () => {
  const paragraphs = readParagraphs("One. Two. Three. Four.");
  const options = { maxChars: 100, wpmSpoken: 150, tailMs: 500 };

  assert.throws(
    () =>
      planDirectedSegments(
        paragraphs,
        [{ afterSentence: 4, targetGapMs: 500 }],
        options,
      ),
    /1\.\.3/,
  );
  assert.throws(
    () =>
      planDirectedSegments(
        paragraphs,
        [
          { afterSentence: 2, targetGapMs: 500 },
          { afterSentence: 2, targetGapMs: 600 },
        ],
        options,
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      planDirectedSegments(
        paragraphs,
        [{ afterSentence: 2, targetGapMs: -1 }],
        options,
      ),
    /Invalid directed pause gap/,
  );
});

test("the committed pause direction is valid, aligned, and selective", () => {
  const direction = PauseDirection.parse(
    readJson("projects/truecrime/voice/pause-direction.json"),
  );
  const script = readScript();
  const hash = createHash("sha256").update(script).digest("hex");
  assert.equal(direction.sourceHash, hash);

  const sentences = readSentences(readParagraphs(script));
  const words = WordTimings.parse(
    readJson("projects/truecrime/voice/words.json"),
  ).words;
  const ends = new Map<number, { text: string; wordId: string; endMs: number }>();
  let cursor = 0;
  for (const sentence of sentences) {
    const slice = words.slice(cursor, cursor + sentence.wordCount);
    ends.set(sentence.index, {
      text: sentence.text,
      wordId: slice[slice.length - 1].id,
      endMs: slice[slice.length - 1].endMs,
    });
    cursor += sentence.wordCount;
  }

  assert.ok(direction.pauses.length >= 8);
  assert.ok(direction.pauses.length <= 11);
  assert.ok(
    direction.pauses.length <= Math.ceil(sentences.length / 2),
    "the director must skip at least half of the sentence ends",
  );
  assert.ok(
    direction.pauses.every((pause) => pause.afterSentence < sentences.length),
    "the final line must not have a trailing pause",
  );

  for (const pause of direction.pauses) {
    const end = ends.get(pause.afterSentence);
    assert.ok(end, `unknown sentence ${pause.afterSentence}`);
    assert.equal(pause.afterText, end.text);
    assert.equal(pause.afterWordId, end.wordId);
    assert.ok(pause.targetGapMs >= 250 && pause.targetGapMs <= 3000);
  }

  const gaps = direction.pauses.map((pause) => pause.targetGapMs);
  const sorted = [...gaps].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median >= 400 && median <= 1000, `median gap ${median}`);

});
