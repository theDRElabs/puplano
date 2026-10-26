import assert from "node:assert/strict";
import test from "node:test";
import { StyleProfile } from "../schemas/style";
import { DEFAULT_STYLE_ID, loadStyle } from "../scripts/style";
import { buildCaptionCues } from "../remotion/src/WordCaptions";
import type { WordTiming } from "../remotion/src/StoryboardVideo";

const flatten = (
  value: unknown,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
};

test("both presets parse and differ in at least six fields", () => {
  assert.equal(DEFAULT_STYLE_ID, "network-truecrime");
  const truecrime = loadStyle(DEFAULT_STYLE_ID);
  const explainer = loadStyle("clean-explainer");

  assert.equal(truecrime.id, "network-truecrime");
  assert.equal(explainer.id, "clean-explainer");

  const left = flatten(truecrime);
  const right = flatten(explainer);
  const keys = new Set([...left.keys(), ...right.keys()]);
  const differing = [...keys].filter((key) => left.get(key) !== right.get(key));

  assert.ok(
    differing.length >= 6,
    `expected at least 6 differing fields, got ${differing.length}: ${differing.join(", ")}`,
  );
});

test("invalid fps and bad hex colours are rejected", () => {
  const badFps = structuredClone(loadStyle(DEFAULT_STYLE_ID)) as any;
  badFps.video.fps = 25;
  const fpsResult = StyleProfile.safeParse(badFps);
  assert.equal(fpsResult.success, false);
  if (fpsResult.success) return;
  assert.ok(fpsResult.error.issues.some((issue) => issue.path.join(".") === "video.fps"));

  const badHex = structuredClone(loadStyle(DEFAULT_STYLE_ID)) as any;
  badHex.palette.background = "#12345";
  const hexResult = StyleProfile.safeParse(badHex);
  assert.equal(hexResult.success, false);
  if (hexResult.success) return;
  assert.ok(hexResult.error.issues.some((issue) => issue.path.join(".") === "palette.background"));
});

test("loader throws a readable error for a missing style", () => {
  assert.throws(
    () => loadStyle("missing-style"),
    /Style "missing-style" not found at styles\/missing-style\.json/,
  );
});

test("buildCaptionCues honours a custom maxWords", () => {
  const words: WordTiming[] = Array.from({ length: 10 }, (_, index) => ({
    word: `word${index}`,
    startMs: index * 250,
    endMs: index * 250 + 200,
  }));

  const byDefault = buildCaptionCues(words);
  assert.ok(byDefault.some((cue) => cue.words.length === 7));

  const custom = buildCaptionCues(words, { maxWords: 4 });
  assert.ok(custom.length > byDefault.length);
  assert.ok(custom.every((cue) => cue.words.length <= 4));
});
