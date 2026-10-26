import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import { Storyboard, type Scene, type License } from "../schemas/storyboard";
import { checksumFile, detailsUrl, downloadUrl, getItem, assertPublicItem, itemLicense,
  isPrivate, readJson, writeJson, type ItemMetadata, type FileChecksums } from "../providers/archive-org";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const checksum = z.object({ bytes: z.number().int().positive(), md5: z.string().regex(/^[a-f0-9]{32}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const probe = z.object({ width: z.number().int().positive(), height: z.number().int().positive(),
  durationMs: z.number().int().positive(), codec: z.enum(["h264", "mpeg4", "hevc", "vp9", "av1"]), fps: z.number().positive() });
const review = z.object({ reviewer: z.string().min(1), evidenceUrls: z.array(z.string().url()).min(1),
  note: z.string().min(20), jurisdiction: z.string().min(2), reviewedAt: z.string().datetime(),
  metadataHash: z.string().length(64), credit: z.string().min(1), shareAlikePlan: z.string().min(20).optional() });
const rights = z.object({ licenseUrls: z.array(z.string().url()).min(1), statements: z.array(z.string()),
  collections: z.array(z.string()), metadataHash: z.string().length(64), checkedAt: z.string().datetime(),
  review: review.optional() });
const assetBase = { id, identifier: id, title: z.string().min(1), creator: z.string().optional(),
  remoteFile: z.string().min(1), detailsUrl: z.string().url(), downloadUrl: z.string().url(),
  localFile: z.string().min(1), checksums: checksum, probe, rights, retrievedAt: z.string().datetime() };
export const Asset = z.discriminatedUnion("kind", [
  z.object({ ...assetBase, kind: z.literal("original") }),
  z.object({ ...assetBase, kind: z.literal("legacy-clip"), parentId: id,
    legacyNote: z.string().min(20) }),
  z.object({ ...assetBase, kind: z.literal("clip"), parentId: id,
    transform: z.object({ startMs: z.number().int().min(0), endMs: z.number().int().positive(),
      createdAt: z.string().datetime(), tool: z.string().min(1), args: z.array(z.string()) }),
    selection: z.object({ sceneId: z.string().min(1), storyboardHash: z.string().length(64),
      shotId: id, previewHash: z.string().length(64), reason: z.string().min(20),
      shotStartMs: z.number().int().min(0), shotEndMs: z.number().int().positive(),
      sampleTimesMs: z.array(z.number().int().min(0)).length(3), reviewImage: z.string().min(1),
      reviewImageHash: z.string().length(64), reviewer: z.string().min(1),
      reviewedAt: z.string().datetime(), illustrative: z.literal(true) }) }),
]);
export type Asset = z.infer<typeof Asset>;
export const Manifest = z.object({ version: z.literal(2), entries: z.array(Asset) }).superRefine((m, ctx) => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const e of m.entries) {
    if (ids.has(e.id) || paths.has(e.localFile)) ctx.addIssue({ code: "custom", message: "Duplicate asset ID/local path" });
    ids.add(e.id); paths.add(e.localFile);
    if (e.kind === "clip" || e.kind === "legacy-clip") {
      const parent = m.entries.find(p => p.id === e.parentId && p.kind === "original");
      if (!parent || parent.identifier !== e.identifier || parent.remoteFile !== e.remoteFile ||
          (e.kind === "clip" && (e.transform.endMs <= e.transform.startMs || e.transform.endMs > parent.probe.durationMs))) {
        ctx.addIssue({ code: "custom", message: `Invalid clip lineage: ${e.id}` });
      }
    }
  }
});
export type Manifest = z.infer<typeof Manifest>;
export const emptyManifest = (): Manifest => ({ version: 2, entries: [] });
export const manifestPath = (projectDir: string) => path.join(projectDir, "assets/media-manifest.json");
export const loadManifest = async (projectDir: string) => {
  const raw = await readJson<unknown>(manifestPath(projectDir), emptyManifest());
  if (!(raw && typeof raw === "object" && "version" in raw)) throw new Error("Legacy manifest: run migrate with the exact original file first");
  return Manifest.parse(raw);
};
export const saveManifest = (projectDir: string, manifest: Manifest) => writeJson(manifestPath(projectDir), Manifest.parse(manifest));
export const assetId = (identifier: string, filename: string) => `${identifier.slice(0, 65)}-${hash(filename).slice(0, 12)}`;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const sceneHash = (scene: Scene) => hash(JSON.stringify({ id: scene.id, startMs: scene.startMs, endMs: scene.endMs, narration: scene.narration }));
export const metadataHash = (item: ItemMetadata) => hash(JSON.stringify({ identifier: item.identifier,
  title: item.title, creator: item.creator, licenseUrls: item.licenseUrls, rights: item.rights, collections: item.collections }));

// Realpath checks cover both existing files and symlinked parent directories.
export const localPath = (projectDir: string, relative: string): string => {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(p => p === "..")) throw new Error(`Unsafe project path: ${relative}`);
  const root = realpathSync(projectDir), target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error(`Path leaves project: ${relative}`);
  let existing = target;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const real = realpathSync(existing);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Symlink leaves project: ${relative}`);
  return target;
};
export const probeVideo = (file: string): Asset["probe"] => {
  const data = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "format=duration:stream=width,height,duration,codec_name,avg_frame_rate", "-of", "json", file], { encoding: "utf8", timeout: 30_000 }));
  const stream = data.streams?.[0];
  if (!stream) throw new Error(`No video stream: ${file}`);
  const [num, den] = String(stream.avg_frame_rate).split("/").map(Number);
  return probe.parse({ width: stream.width, height: stream.height, codec: stream.codec_name,
    durationMs: Math.round(Number(stream.duration ?? data.format?.duration) * 1000), fps: num / den });
};
export const originalAsset = (item: ItemMetadata, remoteFile: string, localFile: string, checks: FileChecksums,
  video: Asset["probe"], retrievedAt = new Date().toISOString()): Asset => {
  assertPublicItem(item);
  if (!itemLicense(item.licenseUrls)) throw new Error("Missing, unsupported, or conflicting license claims");
  const file = item.files.find(f => f.name === remoteFile);
  if (!file || isPrivate(file) || file.md5?.toLowerCase() !== checks.md5 || Number(file.size) !== checks.bytes) throw new Error("Original does not match public source metadata");
  return Asset.parse({ kind: "original", id: assetId(item.identifier, remoteFile), identifier: item.identifier,
    title: item.title, creator: item.creator, remoteFile, detailsUrl: detailsUrl(item.identifier), downloadUrl: downloadUrl(item.identifier, remoteFile),
    localFile, checksums: checks, probe: video, retrievedAt, rights: { licenseUrls: item.licenseUrls, statements: item.rights,
      collections: item.collections, metadataHash: metadataHash(item), checkedAt: new Date().toISOString() } });
};
export const verifyAsset = async (projectDir: string, asset: Asset) => {
  const file = localPath(projectDir, asset.localFile);
  const actual = await checksumFile(file);
  if (actual.sha256 !== asset.checksums.sha256 || actual.md5 !== asset.checksums.md5 || actual.bytes !== asset.checksums.bytes) throw new Error(`Asset changed/corrupted: ${asset.id}`);
  const actualProbe = probeVideo(file);
  if (actualProbe.durationMs !== asset.probe.durationMs || actualProbe.width !== asset.probe.width || actualProbe.height !== asset.probe.height) throw new Error(`Stale measured metadata: ${asset.id}`);
};
export const approveRights = (asset: Asset, input: Omit<z.infer<typeof review>, "reviewedAt" | "metadataHash">): Asset => {
  const rule = itemLicense(asset.rights.licenseUrls);
  if (!rule) throw new Error("Unacceptable license declaration");
  if (rule.shareAlike && !input.shareAlikePlan) throw new Error("CC BY-SA requires an explicit share-alike distribution plan");
  const checked = review.parse({ ...input, metadataHash: asset.rights.metadataHash, reviewedAt: new Date().toISOString() });
  return Asset.parse({ ...asset, rights: { ...asset.rights, review: checked } });
};
export const assertApproved = (asset: Asset) => {
  if (!asset.rights.review || asset.rights.review.metadataHash !== asset.rights.metadataHash) throw new Error(`Rights review missing/stale: ${asset.id}`);
  const rule = itemLicense(asset.rights.licenseUrls);
  if (!rule || (rule.shareAlike && !asset.rights.review.shareAlikePlan)) throw new Error("Rights policy not satisfied");
};
// Schema-level checks cover presence; this covers claim-dependent credit and
// is the single gate used by render, patch, and verify.
export const assertLicenseComplete = (license: License) => {
  const missing: string[] = [];
  if (!license.licenseUrl?.trim()) missing.push("licenseUrl");
  if (!license.attribution?.trim()) missing.push("attribution");
  if (!license.modifications?.trim()) missing.push("modifications");
  const rule = license.licenseUrl ? itemLicense([license.licenseUrl]) : undefined;
  if (rule?.attribution && !license.credit?.trim()) missing.push("credit");
  if (missing.length) throw new Error(`Incomplete media attribution: missing ${missing.join(", ")}`);
};
export const refreshRights = async (asset: Asset): Promise<Asset> => {
  const item = await getItem(asset.identifier, true);
  assertPublicItem(item);
  const remote = item.files.find(f => f.name === asset.remoteFile);
  if (!remote || isPrivate(remote)) throw new Error("Source file is no longer public");
  if (metadataHash(item) !== asset.rights.metadataHash) throw new Error(`Source rights metadata changed; re-download/review ${asset.id}`);
  return asset;
};

export type VisualBrief = { sceneId: string; storyboardHash: string; durationMs: number; narration: string;
  visualIntent: string; queries: string[]; avoid: string[]; status: "needs-discovery" | "selected" | "keep-graphic" };
const visualRules: Array<{ pattern: RegExp; intent: string; queries: string[] }> = [
  { pattern: /precinct|night shift|call came/, intent: "Police station dispatch desk officers telephone at night", queries: ['police AND (station OR dispatch OR telephone)', 'police patrol night'] },
  { pattern: /mill|river street/, intent: "Industrial mill exterior deserted street establishing shot", queries: ['industrial AND (mill OR factory)', 'city street night'] },
  { pattern: /detective|walked the scene/, intent: "Investigator examining a scene police officer searching", queries: ['police AND (investigation OR evidence)', 'detective investigation'] },
  { pattern: /rain|washed away/, intent: "Rain on a city street water and pavement atmospheric detail", queries: ['rain AND street', 'rain city'] },
  { pattern: /security footage|dark coat|timestamp|time of death/, intent: "Pedestrian walking city street at night silhouette; illustrative not real surveillance", queries: ['pedestrian street night', 'police AND (night OR patrol)'] },
  { pattern: /forensic|partial print/, intent: "Fingerprint examination evidence laboratory close-up", queries: ['fingerprint', 'police laboratory'] },
  { pattern: /coworkers|missing|never seen/, intent: "Worker leaving an industrial workplace lonely pedestrian", queries: ['workers factory', 'pedestrian street'] },
  { pattern: /scarf|wallet|phone/, intent: "Evidence detail or restrained typography; do not substitute unrelated victim imagery", queries: ['police evidence'] },
  { pattern: /case went cold|donation/, intent: "Police paperwork case files exterior station", queries: ['police records', 'police station'] },
];
export const planShots = (storyboard: Storyboard): VisualBrief[] => storyboard.scenes.map(scene => {
  const narration = scene.narration ?? ("text" in scene.props ? scene.props.text : "");
  const rule = visualRules.find(r => r.pattern.test(narration.toLowerCase()));
  return { sceneId: scene.id, storyboardHash: sceneHash(scene), durationMs: scene.endMs - scene.startMs,
    narration, visualIntent: rule?.intent ?? `Illustrative visual for: ${narration}`,
    queries: rule?.queries ?? [narration.split(/\s+/).slice(0, 8).join(" ")],
    avoid: ["opening titles", "credits", "commercials", "unrelated faces", "authentic-evidence implication"],
    status: scene.template === "stat_counter" || /wallet|red scarf/.test(narration) ? "keep-graphic" : "needs-discovery" };
});

const Shot = z.object({ id, startMs: z.number().int().min(0), endMs: z.number().int().positive(),
  sampleTimesMs: z.array(z.number().int().min(0)).length(3), image: z.string(), imageHash: z.string().length(64) });
export const Preview = z.object({ version: z.literal(1), assetId: id, sourceHash: z.string().length(64),
  createdAt: z.string().datetime(), skipIntroMs: z.number().int().min(0), detection: z.string(), shots: z.array(Shot) });
export type Preview = z.infer<typeof Preview>;
export const shotWindows = (durationMs: number, cuts: number[], skipIntroMs = 15_000, maxShots = 120) => {
  const boundaries = [...new Set([0, ...cuts.filter(t => t > 0 && t < durationMs), durationMs])].sort((a, b) => a - b);
  const windows: Array<{ startMs: number; endMs: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    // A small guard avoids sampling the cut itself; break long static takes into reviewable windows.
    for (let start = Math.max(boundaries[i] + 150, skipIntroMs); start + 2000 <= boundaries[i + 1] - 150; start += 12_000) {
      windows.push({ startMs: start, endMs: Math.min(start + 12_000, boundaries[i + 1] - 150) });
    }
  }
  // Cover the entire film when bounded, rather than silently reviewing only its beginning.
  if (windows.length <= maxShots) return windows;
  return Array.from({ length: maxShots }, (_, i) => windows[Math.floor(i * windows.length / maxShots)]);
};
export const createPreview = async (projectDir: string, asset: Asset, skipIntroMs = 15_000, maxShots = 120): Promise<Preview> => {
  await verifyAsset(projectDir, asset);
  const relativeDir = `media/previews/${asset.id}`;
  const dir = localPath(projectDir, relativeDir);
  mkdirSync(dir, { recursive: true });
  const file = localPath(projectDir, asset.localFile);
  // Scale first for fast scene detection; scene score is a boundary heuristic, NOT semantic ranking.
  const output = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf",
    "scale=320:-2,select='gt(scene,0.30)',metadata=print:file=-", "-an", "-f", "null", "-"],
    { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 ** 2 });
  const cuts = [...output.matchAll(/pts_time:([\d.]+)/g)].map(m => Math.round(Number(m[1]) * 1000));
  const shots: Preview["shots"] = [];
  for (const [index, window] of shotWindows(asset.probe.durationMs, cuts, skipIntroMs, maxShots).entries()) {
    const shotId = `shot-${String(index + 1).padStart(3, "0")}`;
    const sampleTimesMs = [window.startMs + 200, Math.round((window.startMs + window.endMs) / 2), window.endMs - 200];
    const frameFiles: string[] = [];
    for (const [i, time] of sampleTimesMs.entries()) {
      const frame = path.join(dir, `${shotId}-${i}.jpg`);
      execFileSync("ffmpeg", ["-v", "error", "-ss", String(time / 1000), "-i", file, "-frames:v", "1", "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2", "-y", frame], { timeout: 30_000 });
      frameFiles.push(frame);
    }
    const image = `${relativeDir}/${shotId}.jpg`;
    execFileSync("ffmpeg", ["-v", "error", ...frameFiles.flatMap(f => ["-i", f]), "-filter_complex", "[0:v][1:v][2:v]hstack=inputs=3", "-frames:v", "1", "-y", localPath(projectDir, image)], { timeout: 30_000 });
    shots.push({ id: shotId, ...window, sampleTimesMs, image, imageHash: (await checksumFile(localPath(projectDir, image))).sha256 });
  }
  const result = Preview.parse({ version: 1, assetId: asset.id, sourceHash: asset.checksums.sha256,
    createdAt: new Date().toISOString(), skipIntroMs, detection: "FFmpeg scene-change threshold 0.30; manual visual review required", shots });
  await writeJson(path.join(dir, "shots.json"), result);
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const html = `<!doctype html><meta charset="utf-8"><title>Shot review: ${escape(asset.title)}</title>
    <style>body{background:#101827;color:#eee;font:16px system-ui;margin:24px}img{max-width:100%}article{margin:24px 0}video{width:75%;max-height:480px}</style>
    <h1>${escape(asset.title)}</h1><p>License is an uploader claim. Preview and explain relevance; do not present stock as authentic evidence.</p>
    <video controls preload="metadata" src="../../../${escape(asset.localFile)}"></video>
    ${shots.map(s => `<article><h2>${s.id}: ${(s.startMs / 1000).toFixed(2)}–${(s.endMs / 1000).toFixed(2)} s</h2>
    <p>Frames: ${s.sampleTimesMs.map(t => (t / 1000).toFixed(2)).join(" / ")} s</p><img src="${s.id}.jpg" alt="${s.id} beginning, middle, end"></article>`).join("")}`;
  await import("node:fs/promises").then(fs => fs.writeFile(path.join(dir, "index.html"), html));
  return result;
};

export const validateSelection = (scene: Scene, original: Asset, preview: Preview, shotId: string,
  startMs: number, endMs: number) => {
  assertApproved(original);
  if (original.kind !== "original" || preview.assetId !== original.id || preview.sourceHash !== original.checksums.sha256) throw new Error("Preview does not match original");
  const shot = preview.shots.find(s => s.id === shotId);
  if (!shot || !Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < shot.startMs || endMs > shot.endMs || endMs <= startMs) throw new Error("Selection must stay inside a reviewed shot window");
  if (endMs - startMs < scene.endMs - scene.startMs || endMs > original.probe.durationMs) throw new Error("Shot is too short for the scene");
  return shot;
};
export const selectClip = async (projectDir: string, original: Asset, preview: Preview, scene: Scene,
  input: { shotId: string; startMs: number; endMs: number; reason: string; reviewer: string }): Promise<Asset> => {
  const shot = validateSelection(scene, original, preview, input.shotId, input.startMs, input.endMs);
  if (input.reason.length < 20 || !input.reviewer) throw new Error("Explain visual relevance (20+ characters) and identify the reviewer");
  await verifyAsset(projectDir, original);
  const image = await checksumFile(localPath(projectDir, shot.image));
  if (image.sha256 !== shot.imageHash) throw new Error("Preview image changed; regenerate preview");
  const clipId = `${scene.id.slice(0, 30)}-${hash(JSON.stringify({ source: original.checksums.sha256, ...input })).slice(0, 16)}`;
  const localFile = `assets/clips/${clipId}.mp4`;
  const reviewImage = `media/reviews/${clipId}.jpg`;
  const destination = localPath(projectDir, localFile);
  const reviewDestination = localPath(projectDir, reviewImage);
  mkdirSync(path.dirname(destination), { recursive: true });
  mkdirSync(path.dirname(reviewDestination), { recursive: true });
  if (existsSync(destination) || existsSync(reviewDestination)) throw new Error(`Clip/review evidence already exists: ${clipId}`);
  const args = ["-v", "error", "-ss", String(input.startMs / 1000), "-i", localPath(projectDir, original.localFile),
    "-t", String((input.endMs - input.startMs) / 1000), "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-n", destination];
  try {
    await copyFile(localPath(projectDir, shot.image), reviewDestination);
    if ((await checksumFile(reviewDestination)).sha256 !== shot.imageHash) throw new Error("Failed to preserve reviewed contact sheet");
    execFileSync("ffmpeg", args, { timeout: 120_000 });
    const clip = Asset.parse({ ...original, id: clipId, kind: "clip", localFile, parentId: original.id,
      checksums: await checksumFile(destination), probe: probeVideo(destination),
      transform: { startMs: input.startMs, endMs: input.endMs, createdAt: new Date().toISOString(), tool: "ffmpeg/libx264", args },
      selection: { sceneId: scene.id, storyboardHash: sceneHash(scene), shotId: input.shotId, previewHash: hash(JSON.stringify(preview)),
        shotStartMs: shot.startMs, shotEndMs: shot.endMs, sampleTimesMs: shot.sampleTimesMs,
        reviewImage, reviewImageHash: shot.imageHash, reason: input.reason, reviewer: input.reviewer,
        reviewedAt: new Date().toISOString(), illustrative: true } });
    if (clip.probe.durationMs < scene.endMs - scene.startMs) throw new Error("Encoded clip is too short for scene");
    return clip;
  } catch (error) {
    await Promise.all([rm(destination, { force: true }), rm(reviewDestination, { force: true })]);
    throw error;
  }
};
export const licenseFor = (asset: Asset): License => {
  assertApproved(asset);
  const rule = itemLicense(asset.rights.licenseUrls)!;
  const modifications = asset.kind === "clip" ? `Excerpt ${(asset.transform.startMs / 1000).toFixed(3)}–${(asset.transform.endMs / 1000).toFixed(3)}s; trimmed, audio removed, re-encoded; illustrative use` : "Unmodified download";
  const credit = asset.rights.review!.credit;
  return { type: rule.label, sourceUrl: asset.detailsUrl, licenseUrl: rule.url, credit, modifications,
    attribution: `${asset.title} — ${credit}. Source: ${asset.detailsUrl}. License/claim: ${rule.url}. ${modifications}.` };
};
export const patchScene = (storyboard: Storyboard, clip: Asset): Storyboard => {
  if (clip.kind !== "clip") throw new Error("Select and trim a reviewed shot first; whole films cannot be patched");
  const scene = storyboard.scenes.find(s => s.id === clip.selection.sceneId);
  if (!scene || sceneHash(scene) !== clip.selection.storyboardHash) throw new Error("Scene changed after selection; review again");
  if (clip.probe.durationMs < scene.endMs - scene.startMs) throw new Error("Clip does not cover scene");
  const result = structuredClone(storyboard);
  const index = result.scenes.findIndex(s => s.id === scene.id);
  result.scenes[index] = { id: scene.id, chapter: scene.chapter, startMs: scene.startMs, endMs: scene.endMs,
    narration: scene.narration, layout: 1, transitionIn: scene.transitionIn,
    source: { label: "Illustrative archival footage — not case evidence", url: clip.detailsUrl },
    template: "video_clip", props: { videoFile: clip.localFile, mediaAssetId: clip.id, startFromMs: 0,
      caption: "Illustrative archival footage", license: licenseFor(clip) } };
  return Storyboard.parse(result);
};
export const verifyStoryboardMedia = async (projectDir: string, storyboard: Storyboard) => {
  let manifest: Manifest | undefined;
  const checked = new Set<string>();
  for (const scene of storyboard.scenes) {
    if (scene.template === "image_zoom") {
      assertLicenseComplete(scene.props.license);
      continue;
    }
    if (scene.template === "quote_cutout" && scene.props.imageFile) {
      if (!scene.props.license) throw new Error(`Licensed image requires attribution: ${scene.id}`);
      assertLicenseComplete(scene.props.license);
      continue;
    }
    if (scene.template !== "video_clip") continue;
    const p = scene.props;
    assertLicenseComplete(p.license);
    if (!/^https?:\/\//.test(p.videoFile)) {
      const video = probeVideo(localPath(projectDir, p.videoFile));
      if (video.durationMs < p.startFromMs + scene.endMs - scene.startMs) throw new Error(`Clip too short: ${scene.id}`);
    }
    if (!p.mediaAssetId) {
      if (new URL(p.license.sourceUrl).hostname === "archive.org") throw new Error(`Archive footage requires reviewed asset provenance: ${scene.id}`);
      continue;
    }
    manifest ??= await loadManifest(projectDir);
    const asset = manifest.entries.find(e => e.id === p.mediaAssetId);
    if (!asset || asset.kind !== "clip" || asset.localFile !== p.videoFile || p.startFromMs !== 0) throw new Error(`Scene asset mismatch: ${scene.id}`);
    assertApproved(asset);
    if (asset.selection.sceneId !== scene.id || asset.selection.storyboardHash !== sceneHash(scene)) throw new Error(`Stale shot selection: ${scene.id}`);
    const reviewImage = await checksumFile(localPath(projectDir, asset.selection.reviewImage));
    if (reviewImage.sha256 !== asset.selection.reviewImageHash) {
      throw new Error(`Reviewed contact sheet missing or changed: ${scene.id}`);
    }
    if (!isDeepStrictEqual(p.license, licenseFor(asset))) throw new Error(`Stale attribution: ${scene.id}`);
    const parent = manifest.entries.find(e => e.id === asset.parentId)!;
    for (const e of [parent, asset]) if (!checked.has(e.id)) { await verifyAsset(projectDir, e); checked.add(e.id); }
  }
};
