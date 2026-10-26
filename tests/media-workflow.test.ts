import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { Storyboard } from "../schemas/storyboard";
import { approveRights, assertApproved, createPreview, originalAsset, probeVideo,
  licenseFor, patchScene, sceneHash, shotWindows, validateSelection, saveManifest,
  selectClip, verifyStoryboardMedia, type Asset } from "../scripts/media-workflow";
import { parseArgs } from "../scripts/source-media";
import { checksumFile, type ItemMetadata } from "../providers/archive-org";

const scene = Storyboard.parse({ title: "Test", audioFile: "voice.mp3", durationMs: 5000, scenes: [{
  id: "s1", chapter: 1, startMs: 0, endMs: 5000, layout: 1, template: "kinetic_title",
  narration: "Police examine evidence", props: { text: "Police examine evidence" },
}] }).scenes[0];

const approvedAsset = (): Asset => approveRights({
  kind: "original", id: "source-1", identifier: "source", title: "Source", remoteFile: "source.mp4",
  detailsUrl: "https://archive.org/details/source", downloadUrl: "https://archive.org/download/source/source.mp4",
  localFile: "assets/source.mp4", checksums: { bytes: 1, md5: "0".repeat(32), sha256: "1".repeat(64) },
  probe: { width: 640, height: 480, durationMs: 20_000, codec: "h264", fps: 30 }, retrievedAt: new Date().toISOString(),
  rights: { licenseUrls: ["https://creativecommons.org/licenses/by/4.0/"], statements: [], collections: [],
    metadataHash: "2".repeat(64), checkedAt: new Date().toISOString() },
}, { reviewer: "tester", evidenceUrls: ["https://archive.org/details/source"], note: "Uploader claim reviewed for this exact source.", jurisdiction: "US", credit: "Creator" });

test("shot windows skip introductions and sample the entire bounded film", () => {
  const windows = shotWindows(120_000, [30_000, 60_000, 90_000], 15_000, 4);
  assert.equal(windows.length, 4);
  assert.ok(windows[0].startMs >= 15_000);
  assert.ok(windows.at(-1)!.startMs >= 90_000);
});

test("selection requires approval, exact preview lineage, bounds, and scene coverage", () => {
  const original = approvedAsset();
  const preview = { version: 1 as const, assetId: original.id, sourceHash: original.checksums.sha256,
    createdAt: new Date().toISOString(), skipIntroMs: 0, detection: "test", shots: [{ id: "shot-001", startMs: 1000,
      endMs: 9000, sampleTimesMs: [1200, 5000, 8800] as [number, number, number], image: "preview.jpg", imageHash: "3".repeat(64) }] };
  assert.equal(validateSelection(scene, original, preview, "shot-001", 2000, 8000).id, "shot-001");
  assert.throws(() => validateSelection(scene, original, preview, "shot-001", 2000, 6000), /too short/);
  assert.throws(() => validateSelection(scene, original, preview, "shot-001", 0, 8000), /reviewed shot window/);
  assert.throws(() => validateSelection(scene, { ...original, rights: { ...original.rights, review: undefined } }, preview, "shot-001", 2000, 8000), /missing|stale/);
});

test("share-alike approval needs a distribution plan", () => {
  const source = approvedAsset();
  const pending = { ...source, rights: { ...source.rights, licenseUrls: ["https://creativecommons.org/licenses/by-sa/4.0/"], review: undefined } };
  assert.throws(() => approveRights(pending, { reviewer: "tester", evidenceUrls: [source.detailsUrl],
    note: "Uploader claim reviewed for this exact source.", jurisdiction: "US", credit: "Creator" }), /share-alike/);
  assert.doesNotThrow(() => assertApproved(approveRights(pending, { reviewer: "tester", evidenceUrls: [source.detailsUrl],
    note: "Uploader claim reviewed for this exact source.", jurisdiction: "US", credit: "Creator",
    shareAlikePlan: "Distribute the complete video under CC BY-SA 4.0." })));
});

test("CLI rejects unknown, duplicate, and missing options", () => {
  assert.deepEqual(parseArgs(["demo", "preview", "asset", "--max-shots", "20"]).flags, { "max-shots": "20" });
  assert.throws(() => parseArgs(["demo", "preview", "asset", "--wat", "1"]), /Unknown/);
  assert.throws(() => parseArgs(["demo", "preview", "asset", "--max-shots"]), /Missing value/);
  assert.throws(() => parseArgs(["demo", "preview", "asset", "--max-shots", "2", "--max-shots", "3"]), /duplicate/);
});

test("patching uses a selected derived clip and complete attribution", () => {
  const original = approvedAsset();
  const clip: Asset = { ...original, kind: "clip", id: "clip-1", parentId: original.id,
    localFile: "assets/clips/clip-1.mp4", checksums: { ...original.checksums, sha256: "4".repeat(64) },
    transform: { startMs: 1000, endMs: 7000, createdAt: new Date().toISOString(), tool: "ffmpeg", args: [] },
    selection: { sceneId: scene.id, storyboardHash: sceneHash(scene), shotId: "shot-001", previewHash: "5".repeat(64),
      shotStartMs: 1000, shotEndMs: 9000, sampleTimesMs: [1200, 5000, 8800], reviewImage: "media/reviews/clip-1.jpg",
      reviewImageHash: "6".repeat(64), reason: "The reviewed shot directly supports this scene.", reviewer: "tester",
      reviewedAt: new Date().toISOString(), illustrative: true } };
  const storyboard = Storyboard.parse({ title: "Test", audioFile: "voice.mp3", durationMs: 5000, scenes: [scene] });
  const patched = patchScene(storyboard, clip);
  const selected = patched.scenes[0];
  assert.equal(selected.template, "video_clip");
  if (selected.template !== "video_clip") assert.fail("expected video scene");
  assert.deepEqual(selected.props.license, licenseFor(clip));
  assert.match(selected.props.caption ?? "", /Illustrative/);
});

test("synthetic video preview creates timestamped contact sheets", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "puplano-preview-test-"));
  try {
    await mkdir(path.join(project, "assets"), { recursive: true });
    const file = path.join(project, "assets/source.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=3:r=30",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=3:r=30", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file]);
    const checks = await checksumFile(file);
    const item: ItemMetadata = { identifier: "source", title: "Synthetic", creator: "Test", description: "",
      licenseUrls: ["https://creativecommons.org/publicdomain/zero/1.0/"], rights: [], collections: [], isDark: false,
      restricted: false, noDownload: false, files: [{ name: "source.mp4", size: String(checks.bytes), md5: checks.md5 }] };
    const asset = originalAsset(item, "source.mp4", "assets/source.mp4", checks, probeVideo(file));
    const preview = await createPreview(project, asset, 0, 10);
    assert.ok(preview.shots.length >= 1);
    assert.ok(preview.shots.every(shot => shot.imageHash.length === 64));
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("render-time verification rejects tampered provenance and incomplete attribution", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "puplano-verify-test-"));
  try {
    await mkdir(path.join(project, "assets"), { recursive: true });
    const file = path.join(project, "assets/source.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=6:r=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file]);
    const checks = await checksumFile(file);
    const item: ItemMetadata = { identifier: "source", title: "Synthetic", creator: "Test", description: "",
      licenseUrls: ["https://creativecommons.org/publicdomain/zero/1.0/"], rights: [], collections: [], isDark: false,
      restricted: false, noDownload: false, files: [{ name: "source.mp4", size: String(checks.bytes), md5: checks.md5 }] };
    const original = approveRights(originalAsset(item, "source.mp4", "assets/source.mp4", checks, probeVideo(file)), {
      reviewer: "tester", evidenceUrls: ["https://archive.org/details/source"],
      note: "Uploader claim reviewed for this exact source.", jurisdiction: "US", credit: "Creator" });
    const preview = await createPreview(project, original, 0, 10);
    const shot = preview.shots.find(candidate => candidate.endMs - candidate.startMs >= 5000);
    assert.ok(shot, "preview must produce a shot long enough for the scene");
    const clip = await selectClip(project, original, preview, scene, { shotId: shot.id,
      startMs: shot.startMs + 100, endMs: shot.endMs - 100,
      reason: "Reviewed shot directly supports this scene.", reviewer: "tester" });
    await saveManifest(project, { version: 2, entries: [original, clip] });
    const storyboard = patchScene(Storyboard.parse({ title: "Test", audioFile: "voice.mp3", durationMs: 5000,
      scenes: [scene] }), clip);
    await verifyStoryboardMedia(project, storyboard);

    const broken = structuredClone(storyboard);
    const brokenScene = broken.scenes[0];
    if (brokenScene.template !== "video_clip") assert.fail("expected video scene");
    brokenScene.props.license.attribution = "";
    await assert.rejects(verifyStoryboardMedia(project, broken), /Incomplete media attribution/);

    await appendFile(path.join(project, clip.localFile), "tampered");
    await assert.rejects(verifyStoryboardMedia(project, storyboard), /changed\/corrupted/);
  } finally { await rm(project, { recursive: true, force: true }); }
});
