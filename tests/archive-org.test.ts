import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ArchiveClient,
  assertPublicItem,
  classifyLicense,
  itemLicense,
  rankCandidate,
  retryAfterMs,
  type Candidate,
  type ItemMetadata,
} from "../providers/archive-org";

test("license classification validates the exact URL", () => {
  assert.equal(classifyLicense("https://creativecommons.org/licenses/by/4.0/")?.id, "by");
  assert.equal(classifyLicense("http://creativecommons.org/licenses/publicdomain/")?.id, "pdm");
  assert.equal(classifyLicense("https://creativecommons.org/licenses/by/4.0/deed.en")?.id, "by");
  for (const value of [
    "https://notcreativecommons.org/licenses/by/4.0/",
    "https://example.com/?license=https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org.evil.test/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by/9.9/",
    "https://creativecommons.org/licenses/by-nc/4.0/",
    "javascript:https://creativecommons.org/licenses/by/4.0/",
  ]) assert.equal(classifyLicense(value), undefined, value);
});

test("multiple license declarations must all agree", () => {
  assert.equal(itemLicense([
    "https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by/4.0/legalcode",
  ])?.id, "by");
  assert.equal(itemLicense([
    "https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org/publicdomain/zero/1.0/",
  ]), undefined);
  assert.equal(itemLicense(["https://creativecommons.org/licenses/by/4.0/", "garbage"]), undefined);
});

test("Retry-After handles seconds and HTTP dates", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(retryAfterMs("120", now), 120_000);
  assert.equal(retryAfterMs("Sat, 24 Oct 2026 12:02:00 GMT", now), 120_000);
  assert.equal(retryAfterMs("bad", now), undefined);
});

test("restricted item states are rejected", () => {
  const base: ItemMetadata = { identifier: "item", title: "Item", licenseUrls: [], rights: [], collections: [],
    description: "", isDark: false, restricted: false, noDownload: false, files: [] };
  assert.doesNotThrow(() => assertPublicItem(base));
  for (const key of ["isDark", "restricted", "noDownload"] as const) {
    assert.throws(() => assertPublicItem({ ...base, [key]: true }), /restricted|unavailable/);
  }
});

test("metadata ranking favors visual matches and penalizes commercials", () => {
  const base: Candidate = { identifier: "x", title: "Police investigation station", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    license: "CC0", attributionRequired: false, detailsUrl: "https://archive.org/details/x", thumbnailUrl: "https://archive.org/services/img/x",
    description: "Officers inspect evidence", subjects: ["Police"], relevanceScore: 0, matchedTerms: [], warnings: [] };
  const relevant = rankCandidate(base, "police station evidence");
  const ad = rankCandidate({ ...base, title: "Commercial trailer", description: "" }, "police station evidence");
  assert.ok(relevant.relevanceScore > ad.relevanceScore);
  assert.deepEqual(relevant.matchedTerms.sort(), ["evidence", "police", "station"]);
});

test("download retries an interrupted stream from the beginning and verifies it", async () => {
  const content = Buffer.from("complete media payload");
  const md5 = createHash("md5").update(content).digest("hex");
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(content.subarray(0, 5));
          controller.error(new Error("connection reset"));
        },
      }), { status: 200 });
    }
    return new Response(content, { status: 200 });
  };
  const dir = await mkdtemp(path.join(tmpdir(), "puplano-download-test-"));
  try {
    const destination = path.join(dir, "video.mp4");
    const client = new ArchiveClient({ fetch: fetchMock, cacheDir: false, intervalMs: 0, retries: 1, sleep: async () => {}, random: () => 0 });
    const result = await client.download("test_item", { name: "video.mp4", size: String(content.length), md5 }, destination);
    assert.equal(calls, 2);
    assert.equal(result.md5, md5);
    assert.deepEqual(await readFile(destination), content);
    assert.deepEqual((await readdir(dir)).filter(file => file.endsWith(".part")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("successful JSON responses are cached but API errors are not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "puplano-cache-test-"));
  let calls = 0;
  const client = new ArchiveClient({ cacheDir: dir, intervalMs: 0, retries: 0, fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ value: 7 }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  try {
    assert.deepEqual(await client.json("https://archive.org/test"), { value: 7 });
    assert.deepEqual(await client.json("https://archive.org/test"), { value: 7 });
    assert.equal(calls, 1);

    let errorCalls = 0;
    const errors = new ArchiveClient({ cacheDir: dir, intervalMs: 0, retries: 0, fetch: async () => {
      errorCalls++;
      return new Response(JSON.stringify({ error: "temporary" }), { status: 200, headers: { "content-type": "application/json" } });
    } });
    await assert.rejects(errors.json("https://archive.org/error"), /API error/);
    await assert.rejects(errors.json("https://archive.org/error"), /API error/);
    assert.equal(errorCalls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the file lock serializes separate processes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "puplano-lock-test-"));
  const lock = path.join(dir, "shared.lock");
  const log = path.join(dir, "log.txt");
  const child = path.join(dir, "child.mts");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const provider = pathToFileURL(path.join(repoRoot, "providers/archive-org.ts")).href;
  await writeFile(child, `
const [lock, log, id] = process.argv.slice(2);
(async () => {
  const { withFileLock } = await import(process.env.AW_PROVIDER as string);
  const { appendFileSync } = await import("node:fs");
  await withFileLock(lock, async () => {
    const start = Date.now();
    await new Promise(resolve => setTimeout(resolve, 400));
    appendFileSync(log, id + " " + start + " " + Date.now() + "\\n");
  });
})().catch(error => { console.error(error); process.exit(1); });
`);
  const run = (id: string) => new Promise<void>((resolve, reject) => {
    const proc = spawn(path.join(repoRoot, "node_modules/.bin/tsx"), [child, lock, log, id],
      { env: { ...process.env, AW_PROVIDER: provider }, stdio: "inherit" });
    proc.on("error", reject);
    proc.on("exit", code => code === 0 ? resolve() : reject(new Error(`${id} exited ${code}`)));
  });
  try {
    await Promise.all([run("a"), run("b")]);
    const entries = (await readFile(log, "utf8")).trim().split("\n").map(line => {
      const [id, start, end] = line.split(" ");
      return { id, start: Number(start), end: Number(end) };
    });
    assert.equal(entries.length, 2);
    const [first, second] = entries.sort((a, b) => a.start - b.start);
    assert.ok(first.end - first.start >= 350, "the first holder must hold the lock");
    assert.ok(second.start >= first.end, `lock holders overlapped: ${JSON.stringify(entries)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("clients sharing a cache directory reserve rate slots across instances", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "puplano-rate-test-"));
  let now = 0;
  const waits: number[] = [];
  const make = () => new ArchiveClient({ cacheDir: dir, intervalMs: 1000, retries: 0,
    now: () => now, sleep: async ms => { waits.push(ms); now += ms; },
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) });
  try {
    await Promise.all([
      make().json("https://archive.org/one", 0, true),
      make().json("https://archive.org/two", 0, true),
    ]);
    assert.ok(waits.some(ms => ms >= 900), `expected a reserved wait, saw ${waits.join(",") || "none"}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
