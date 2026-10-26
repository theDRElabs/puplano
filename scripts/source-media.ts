import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Storyboard } from "../schemas/storyboard";
import { search, getItem, assertPublicItem, pickVideoFile, isPrivate, downloadFile, checksumFile,
  readJson, writeJson, withFileLock, type Candidate } from "../providers/archive-org";
import { Asset, Preview, loadManifest, saveManifest, manifestPath, emptyManifest, originalAsset,
  assetId, localPath, probeVideo, planShots, createPreview, approveRights, refreshRights, verifyAsset,
  selectClip, patchScene, licenseFor, verifyStoryboardMedia, hash, type VisualBrief } from "./media-workflow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS: Record<string, { count: number; flags: string[] }> = {
  plan: { count: 0, flags: [] },
  search: { count: 1, flags: ["rows", "pages", "collection", "scene", "include-share-alike"] },
  discover: { count: 0, flags: ["rows", "pages", "collection", "scene", "include-share-alike"] },
  download: { count: 1, flags: ["file"] },
  migrate: { count: 1, flags: ["file", "original"] },
  preview: { count: 1, flags: ["skip-intro", "max-shots"] },
  approve: { count: 1, flags: ["reviewer", "evidence", "note", "jurisdiction", "credit", "share-alike-plan"] },
  select: { count: 2, flags: ["shot", "start", "end", "reason", "reviewer"] },
  patch: { count: 1, flags: [] },
  verify: { count: 0, flags: [] },
};
export const parseArgs = (args: string[]) => {
  const [project, command, ...rest] = args;
  if (!project || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project) || !COMMANDS[command]) throw new Error("Usage: source-media <project> plan|discover|search|download|migrate|preview|approve|select|patch|verify (see README)");
  const spec = COMMANDS[command], positional: string[] = [], flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) { positional.push(rest[i]); continue; }
    const flag = rest[i].slice(2);
    if (!spec.flags.includes(flag) || flag in flags) throw new Error(`Unknown/duplicate option: --${flag}`);
    if (flag === "include-share-alike") { flags[flag] = "true"; continue; }
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${flag}`);
    flags[flag] = value;
  }
  if (positional.length !== spec.count) throw new Error(`${command} requires ${spec.count} positional arguments`);
  return { project, command, positional, flags };
};
const required = (flags: Record<string, string>, key: string) => { if (!flags[key]) throw new Error(`Missing --${key}`); return flags[key]; };
const number = (value: string | undefined, fallback: number, min: number, max: number, integer = true) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`Expected ${min}–${max}${integer ? " integer" : " number"}, received ${value}`);
  return n;
};
export const main = async (args = process.argv.slice(2), root = ROOT) => {
  const { project, command, positional, flags } = parseArgs(args);
  const projectDir = path.join(root, "projects", project);
  if (!existsSync(projectDir)) throw new Error(`Project not found: ${project}`);
  const mediaDir = localPath(projectDir, "media");
  mkdirSync(mediaDir, { recursive: true });
  return withFileLock(path.join(mediaDir, "workflow.lock"), async () => {
    const sbFile = localPath(projectDir, "storyboard/storyboard.json");
    const storyboard = () => Storyboard.parse(JSON.parse(readFileSync(sbFile, "utf8")));
    const findAsset = async (id: string) => {
      const manifest = await loadManifest(projectDir), asset = manifest.entries.find(e => e.id === id);
      if (!asset) throw new Error(`Unknown asset ID ${id}; use an exact manifest ID, not the item identifier`);
      return { manifest, asset };
    };
    if (command === "plan") {
      const file = path.join(mediaDir, "shot-plan.json");
      if (existsSync(file)) throw new Error("Shot plan exists; edit it or preserve it before regenerating");
      await writeJson(file, { version: 1, scenes: planShots(storyboard()) });
      console.log("Created media/shot-plan.json; edit visual intents/queries before discovery."); return;
    }
    if (command === "search" || command === "discover") {
      const sb = storyboard();
      const plan = await readJson<{ scenes: VisualBrief[] }>(path.join(mediaDir, "shot-plan.json"), { scenes: planShots(sb) });
      const scene = flags.scene ? plan.scenes.find(s => s.sceneId === flags.scene) : undefined;
      if (flags.scene && !scene) throw new Error(`Unknown scene: ${flags.scene}`);
      const requests = command === "search" ? [{ query: positional[0], scene }] :
        plan.scenes.filter(s => (!flags.scene || s.sceneId === flags.scene) && s.status === "needs-discovery").flatMap(s => s.queries.map(query => ({ query, scene: s })));
      const all = new Map<string, Candidate>();
      for (const request of requests) {
        const candidates = await search({ query: request.query, visualIntent: request.scene?.visualIntent,
          rows: number(flags.rows, 12, 1, 100), pages: number(flags.pages, 2, 1, 5), collection: flags.collection,
          licenses: flags["include-share-alike"] ? ["pdm", "cc0", "by", "by-sa"] : ["pdm", "cc0", "by"] });
        const key = hash(JSON.stringify({ query: request.query, scene: request.scene?.sceneId, flags })).slice(0, 16);
        await writeJson(path.join(mediaDir, "searches", `${key}.json`), { ...request, flags, candidates, searchedAt: new Date().toISOString() });
        for (const c of candidates) { if (!all.has(c.identifier) || c.relevanceScore > all.get(c.identifier)!.relevanceScore) all.set(c.identifier, c); }
        console.log(`${request.scene?.sceneId ?? "search"}: ${request.query} → ${candidates.length} candidates`);
      }
      const candidates = [...all.values()].sort((a, b) => b.relevanceScore - a.relevanceScore);
      await writeJson(path.join(mediaDir, "candidates.json"), candidates);
      console.log(candidates.map(c => `${c.identifier} | score ${c.relevanceScore} | ${c.title} | ${c.detailsUrl}`).join("\n")); return;
    }
    if (command === "download" || command === "migrate") {
      const item = await getItem(positional[0], true); assertPublicItem(item);
      const file = flags.file ? item.files.find(f => f.name === flags.file) : pickVideoFile(item.files);
      if (!file || isPrivate(file) || !/\.mp4$/i.test(file.name)) throw new Error("No public MP4 file found");
      if (Number(file.size) > 2 * 1024 ** 3) throw new Error("File exceeds 2 GiB safety budget; choose another derivative");
      const id = assetId(item.identifier, file.name);
      const manifest = command === "migrate" ? emptyManifest() : await loadManifest(projectDir);
      const localFile = command === "migrate" ? required(flags, "original") : `assets/originals/${id}.mp4`;
      const destination = localPath(projectDir, localFile);
      const checks = command === "migrate" ? await checksumFile(destination) : await downloadFile(item.identifier, file, destination);
      const entry = originalAsset(item, file.name, localFile, checks, probeVideo(destination));
      if (command === "migrate") {
        const legacy = await readJson<{ version?: number; entries?: Array<{ identifier: string; localFile: string; retrievedAt?: string }> }>(manifestPath(projectDir), {});
        if (legacy.version || legacy.entries?.length !== 1 || legacy.entries[0].identifier !== item.identifier) throw new Error("Migration expects a single-item legacy manifest; refusing to discard other records");
        const backup = path.join(mediaDir, "legacy-media-manifest.json");
        if (existsSync(backup)) throw new Error("Legacy backup already exists; refusing to overwrite");
        await writeJson(backup, legacy);
        entry.retrievedAt = legacy.entries[0].retrievedAt ?? entry.retrievedAt;
        const oldClip = legacy.entries[0].localFile;
        if (oldClip !== localFile) manifest.entries.push(Asset.parse({ ...entry, id: `${id}-legacy`, kind: "legacy-clip", parentId: id,
          localFile: oldClip, checksums: await checksumFile(localPath(projectDir, oldClip)), probe: probeVideo(localPath(projectDir, oldClip)),
          legacyNote: "Recovered legacy derivative: source in/out times were not recorded. Opening credits rejected; not eligible for selection or patching." }));
      }
      const existing = manifest.entries.find(e => e.id === id);
      if (existing?.rights.metadataHash === entry.rights.metadataHash) entry.rights.review = existing.rights.review;
      manifest.entries = [...manifest.entries.filter(e => e.id !== id), entry];
      await saveManifest(projectDir, manifest); console.log(`Original asset: ${id}`); return;
    }
    if (command === "preview") {
      const { asset } = await findAsset(positional[0]);
      if (asset.kind !== "original") throw new Error("Preview an original asset, not a derived clip");
      const preview = await createPreview(projectDir, asset, Math.round(number(flags["skip-intro"], 15, 0, asset.probe.durationMs / 1000, false) * 1000), number(flags["max-shots"], 60, 1, 120));
      console.log(`${preview.shots.length} shot windows: media/previews/${asset.id}/index.html`); return;
    }
    if (command === "approve") {
      const { manifest, asset } = await findAsset(positional[0]);
      if (asset.kind !== "original") throw new Error("Review original rights before creating clips");
      await verifyAsset(projectDir, asset); await refreshRights(asset);
      const updated = approveRights(asset, { reviewer: required(flags, "reviewer"), evidenceUrls: required(flags, "evidence").split(","),
        note: required(flags, "note"), jurisdiction: required(flags, "jurisdiction"), credit: flags.credit ?? asset.creator ?? required(flags, "credit"),
        shareAlikePlan: flags["share-alike-plan"] });
      manifest.entries = manifest.entries.map(e => e.id === asset.id ? updated : e);
      await saveManifest(projectDir, manifest); console.log("Recorded rights review (not an Archive.org guarantee of clearance)."); return;
    }
    if (command === "select") {
      const { manifest, asset } = await findAsset(positional[0]);
      const sb = storyboard(), scene = sb.scenes.find(s => s.id === positional[1]);
      if (!scene) throw new Error(`Unknown scene: ${positional[1]}`);
      await refreshRights(asset);
      const preview = Preview.parse(await readJson(localPath(projectDir, `media/previews/${asset.id}/shots.json`), null));
      const clip = await selectClip(projectDir, asset, preview, scene, { shotId: required(flags, "shot"),
        startMs: Math.round(number(required(flags, "start"), 0, 0, asset.probe.durationMs / 1000, false) * 1000),
        endMs: Math.round(number(required(flags, "end"), 0, 0, asset.probe.durationMs / 1000, false) * 1000),
        reason: required(flags, "reason"), reviewer: required(flags, "reviewer") });
      manifest.entries.push(clip); await saveManifest(projectDir, manifest); console.log(`Selected clip: ${clip.id}`); return;
    }
    if (command === "patch") {
      const { manifest, asset } = await findAsset(positional[0]);
      await verifyAsset(projectDir, asset); await refreshRights(asset);
      const sb = patchScene(storyboard(), asset);
      await verifyStoryboardMedia(projectDir, sb);
      await writeJson(sbFile, sb);
      const used = new Set(sb.scenes.flatMap(s => s.template === "video_clip" && s.props.mediaAssetId ? [s.props.mediaAssetId] : []));
      writeFileSync(path.join(mediaDir, "credits.md"), "# Footage credits\n\nIllustrative archival footage, not authentic case evidence.\n\n" + manifest.entries.filter(e => used.has(e.id)).map(e => licenseFor(e).attribution).join("\n\n") + "\n");
      console.log(`Patched ${asset.id}; full attribution in media/credits.md`); return;
    }
    if (command === "verify") {
      const manifest = await loadManifest(projectDir);
      for (const asset of manifest.entries) await verifyAsset(projectDir, asset);
      await verifyStoryboardMedia(projectDir, storyboard());
      console.log(`Verified ${manifest.entries.length} assets and storyboard media`);
    }
  });
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
