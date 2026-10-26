import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { rename, rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const BASE = "https://archive.org";
export const USER_AGENT = ["Puplano/0.2 (source-media)", process.env.PUPLANO_UA_SUFFIX]
  .filter(Boolean).join(" ");
export const LICENSE_RULES = [
  { id: "pdm", label: "Public domain", attribution: false, shareAlike: false },
  { id: "cc0", label: "CC0", attribution: false, shareAlike: false },
  { id: "by", label: "CC BY", attribution: true, shareAlike: false },
  { id: "by-sa", label: "CC BY-SA", attribution: true, shareAlike: true },
] as const;
export type LicenseRule = { id: string; label: string; attribution: boolean; shareAlike: boolean; url: string };

// Classification of an uploader's claim, NOT verification of reuse permission.
export const classifyLicense = (value: string | undefined): LicenseRule | undefined => {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== "creativecommons.org" ||
      url.port || url.username || url.password || url.search || url.hash) return undefined;
  const pathname = url.pathname.replace(/\/(deed\.[a-z-]+|legalcode)\/?$/, "/").replace(/\/$/, "");
  let id: string;
  let version = "";
  if (pathname === "/licenses/publicdomain" || pathname === "/publicdomain/mark/1.0") id = "pdm";
  else if (pathname === "/publicdomain/zero/1.0") { id = "cc0"; version = "1.0"; }
  else {
    const match = pathname.match(/^\/licenses\/(by|by-sa)\/(1\.0|2\.0|2\.5|3\.0|4\.0)$/);
    if (!match) return undefined;
    [, id, version] = match;
  }
  const rule = LICENSE_RULES.find(r => r.id === id)!;
  return { ...rule, label: [rule.label, version].filter(Boolean).join(" "), url: `https://creativecommons.org${pathname}/` };
};

export const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && !!v.trim()).map(v => v.trim());
export const itemLicense = (urls: string[]): LicenseRule | undefined => {
  const rules = urls.map(classifyLicense);
  // Unknown or conflicting declarations require investigation, not first-value selection.
  return rules.length && rules.every(r => r && r.url === rules[0]?.url) ? rules[0] : undefined;
};
export const assertIdentifier = (identifier: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(identifier)) throw new Error(`Invalid Archive.org identifier: ${identifier}`);
};
export const detailsUrl = (identifier: string) => {
  assertIdentifier(identifier);
  return `${BASE}/details/${encodeURIComponent(identifier)}`;
};
export const downloadUrl = (identifier: string, file: string) => {
  assertIdentifier(identifier);
  if (!file || file.includes("\\") || file.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe remote filename");
  return `${BASE}/download/${encodeURIComponent(identifier)}/${file.split("/").map(encodeURIComponent).join("/")}`;
};
export const retryAfterMs = (header: string | null, now = Date.now()): number | undefined => {
  if (header === null || !header.trim()) return undefined;
  if (/^\d+(\.\d+)?$/.test(header.trim())) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
};

export const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
};
export const writeJson = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.part`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n"); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Crash-recoverable lock; never evict a lock owned by a live process.
export const withFileLock = async <T>(file: string, work: () => Promise<T>): Promise<T> => {
  await mkdir(path.dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try { await mkdir(file); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readJson<{ pid?: number }>(path.join(file, "owner.json"), {});
      let stale = false;
      if (owner.pid) {
        try { process.kill(owner.pid, 0); }
        catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      } else {
        try { stale = Date.now() - (await stat(file)).mtimeMs > 30_000; } catch { continue; }
      }
      if (stale) { await rm(file, { recursive: true, force: true }); continue; }
      if (Date.now() - started > 900_000) throw new Error(`Timed out waiting for ${file}`);
      await sleep(100);
    }
  }
  try { await writeJson(path.join(file, "owner.json"), { pid: process.pid }); return await work(); }
  finally { await rm(file, { recursive: true, force: true }); }
};

class PermanentError extends Error {}
type ClientOptions = {
  fetch?: typeof fetch;
  cacheDir?: string | false;
  intervalMs?: number;
  retries?: number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};
export class ArchiveClient {
  private options: Required<ClientOptions>;
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(options: ClientOptions = {}) {
    this.options = { fetch: globalThis.fetch, cacheDir: path.join(homedir(), ".cache/puplano/archive-org"),
      intervalMs: 1000, retries: 4, timeoutMs: 30_000, downloadTimeoutMs: 600_000,
      sleep, now: Date.now, random: Math.random, ...options };
  }
  private async schedule(notBefore = 0, reserve = true) {
    const schedule = async () => {
      const file = this.options.cacheDir && path.join(this.options.cacheDir, "rate.json");
      const state = file ? await readJson<{ nextAt: number }>(file, { nextAt: 0 }) : { nextAt: this.nextAt };
      const next = Math.max(state.nextAt, this.nextAt, notBefore);
      if (reserve && next > this.options.now()) await this.options.sleep(next - this.options.now());
      this.nextAt = reserve ? this.options.now() + this.options.intervalMs : next;
      if (file) await writeJson(file, { nextAt: this.nextAt });
    };
    if (this.options.cacheDir) await withFileLock(path.join(this.options.cacheDir, "rate.lock"), schedule);
    else await schedule();
  }
  private request<T>(url: string, consume: (response: Response, signal: AbortSignal) => Promise<T>, timeoutMs = this.options.timeoutMs): Promise<T> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        await this.schedule();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("Archive.org request timed out")), timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.options.fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: controller.signal });
          if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
          if (!response.ok) throw new PermanentError(`Archive.org HTTP ${response.status}: ${url}`);
          return await consume(response, controller.signal);
        } catch (error) {
          if (error instanceof PermanentError || attempt >= this.options.retries) throw error;
          const backoff = Math.min(30_000, 2000 * 2 ** attempt) + Math.round(this.options.random() * 500);
          const delay = Math.max(backoff, retryAfterMs(response?.headers.get("retry-after") ?? null, this.options.now()) ?? 0);
          await this.schedule(this.options.now() + delay, false);
        } finally {
          clearTimeout(timer);
          if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
          controller.abort();
        }
      }
    };
    const task = this.queue.then(run);
    this.queue = task.catch(() => {});
    return task;
  }
  async json<T>(url: string, ttlMs = 900_000, fresh = false): Promise<T> {
    const cache = this.options.cacheDir && path.join(this.options.cacheDir, "responses", createHash("sha256").update(url).digest("hex") + ".json");
    if (cache && !fresh) {
      const envelope = await readJson<{ expiresAt: number; value: T } | null>(cache, null).catch(() => null);
      if (envelope && envelope.expiresAt > this.options.now()) return envelope.value;
    }
    const value = await this.request(url, response => response.json() as Promise<T>);
    // Invalid API responses and transient errors must never become successful cache entries.
    if (value && typeof value === "object" && "error" in value) throw new Error(`Archive.org API error: ${JSON.stringify(value)}`);
    if (cache) await writeJson(cache, { expiresAt: this.options.now() + ttlMs, value });
    return value;
  }
  async download(identifier: string, file: ItemFile, destination: string): Promise<FileChecksums> {
    if (isPrivate(file) || !/\.mp4$/i.test(file.name)) throw new PermanentError("Only public MP4 footage is downloadable");
    const url = downloadUrl(identifier, file.name);
    if (!file.md5 || !/^[a-f0-9]{32}$/i.test(file.md5) || !(Number(file.size) > 0)) throw new PermanentError("Source file lacks checksum/size metadata");
    const matches = (checks: FileChecksums) => checks.md5 === file.md5!.toLowerCase() && checks.bytes === Number(file.size);
    try { const existing = await checksumFile(destination); if (matches(existing)) return existing; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(path.dirname(destination), { recursive: true });
    return this.request(url, async (response, signal) => {
      const temp = `${destination}.${randomUUID()}.part`;
      const md5 = createHash("md5"), sha256 = createHash("sha256");
      let bytes = 0;
      try {
        if (!response.body) throw new Error("Empty download response");
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > Number(file.size)) return callback(new Error("Download exceeds expected source size"));
          md5.update(chunk); sha256.update(chunk); callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), meter, createWriteStream(temp), { signal });
        const checks = { bytes, md5: md5.digest("hex"), sha256: sha256.digest("hex") };
        if (!matches(checks)) throw new Error(`Size/checksum mismatch for ${file.name}`);
        await rename(temp, destination);
        return checks;
      } finally { await rm(temp, { force: true }); }
    }, this.options.downloadTimeoutMs);
  }
}
export type FileChecksums = { bytes: number; md5: string; sha256: string };
export const checksumFile = async (file: string): Promise<FileChecksums> => {
  const md5 = createHash("md5"), sha256 = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { bytes += chunk.length; md5.update(chunk); sha256.update(chunk); }
  return { bytes, md5: md5.digest("hex"), sha256: sha256.digest("hex") };
};
export const client = new ArchiveClient();
const flag = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
export type ItemFile = { name: string; format?: string; size?: string; md5?: string; width?: string;
  height?: string; length?: string; source?: string; original?: string; private?: string | boolean; };
export const isPrivate = (file: ItemFile) => flag(file.private);
export type ItemMetadata = { identifier: string; title: string; creator?: string; licenseUrls: string[];
  rights: string[]; collections: string[]; description: string; isDark: boolean; restricted: boolean;
  noDownload: boolean; files: ItemFile[]; itemLastUpdated?: number; };
export const getItem = async (identifier: string, fresh = false, api = client): Promise<ItemMetadata> => {
  assertIdentifier(identifier);
  const body = await api.json<{ metadata?: Record<string, unknown>; files?: ItemFile[]; is_dark?: unknown; nodownload?: unknown; item_last_updated?: number }>(`${BASE}/metadata/${encodeURIComponent(identifier)}?extended_err=1`, 900_000, fresh);
  if (!body.metadata) throw new Error(`Archive.org item not found/unavailable: ${identifier}`);
  const m = body.metadata;
  return { identifier, title: strings(m.title).join("; ") || identifier, creator: strings(m.creator).join("; ") || undefined,
    licenseUrls: strings(m.licenseurl), rights: strings(m.rights), collections: strings(m.collection),
    description: plainText(strings(m.description).join(" ")), isDark: flag(body.is_dark),
    restricted: flag(m["access-restricted-item"]) || flag(m["access-restricted"]),
    noDownload: flag(body.nodownload), files: body.files ?? [], itemLastUpdated: body.item_last_updated };
};
export const assertPublicItem = (item: ItemMetadata) => {
  if (item.isDark || item.restricted || item.noDownload) throw new Error(`Item is restricted/dark/unavailable: ${item.identifier}`);
};
export const pickVideoFile = (files: ItemFile[]): ItemFile | undefined => files
  .filter(f => !isPrivate(f) && /\.mp4$/i.test(f.name) && f.format !== "Metadata" && Number(f.size) > 0 && Number(f.size) <= 2 * 1024 ** 3)
  .sort((a, b) => Number(b.width ?? 0) * Number(b.height ?? 0) - Number(a.width ?? 0) * Number(a.height ?? 0) ||
    Number(/h\.264/i.test(b.format ?? "")) - Number(/h\.264/i.test(a.format ?? "")) || Number(b.size) - Number(a.size))[0];
export const plainText = (text: string) => text.replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|quot|lt|gt);/g, " ").replace(/\s+/g, " ").trim();
export type Candidate = { identifier: string; title: string; creator?: string; year?: string; runtime?: string;
  licenseUrl: string; license: string; attributionRequired: boolean; detailsUrl: string; thumbnailUrl: string;
  description: string; subjects: string[]; relevanceScore: number; matchedTerms: string[]; warnings: string[]; downloads?: number; };
const STOP = new Set("and or not the a an of in to on at for with from this that movies identifier collection mediatype licenseurl".split(" "));
export const visualTerms = (query: string) => [...new Set(query.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter(t => !STOP.has(t));
export const rankCandidate = (candidate: Candidate, intent: string): Candidate => {
  const terms = visualTerms(intent);
  const title = candidate.title.toLowerCase(), subjects = candidate.subjects.join(" ").toLowerCase(), desc = candidate.description.toLowerCase();
  const matches = terms.filter(t => title.includes(t) || subjects.includes(t) || desc.includes(t));
  let score = terms.reduce((s, t) => s + (title.includes(t) ? 12 : 0) + (subjects.includes(t) ? 6 : 0) + (desc.includes(t) ? 1 : 0), 0);
  const warnings = ["Metadata match only: inspect actual shots before selection"];
  if (/commercial|advertis|cartoon|trailer/.test(title) && !/commercial|advertis|cartoon|trailer/.test(intent)) {
    score -= 30; warnings.push("Likely off-topic compilation/promotional footage");
  }
  return { ...candidate, relevanceScore: score, matchedTerms: matches, warnings };
};
export type SearchOptions = { query: string; rows?: number; pages?: number; collection?: string;
  mediatype?: "movies" | "image"; licenses?: string[]; visualIntent?: string; fresh?: boolean; };
export const search = async (options: SearchOptions, api = client): Promise<Candidate[]> => {
  const rows = options.rows ?? 20, pages = options.pages ?? 3;
  if (!options.query.trim() || options.query.length > 2000) throw new Error("Search query must be 1–2000 characters");
  if (!Number.isInteger(rows) || rows < 1 || rows > 100 || !Number.isInteger(pages) || pages < 1 || pages > 5) throw new Error("rows must be 1–100; pages must be 1–5");
  if (options.collection) assertIdentifier(options.collection);
  const allowed = options.licenses ?? ["pdm", "cc0", "by"];
  if (!allowed.length || allowed.some(id => !LICENSE_RULES.some(r => r.id === id))) throw new Error("Invalid license policy");
  const clauses = [`(${options.query})`, `mediatype:${options.mediatype ?? "movies"}`, "licenseurl:*", "-access-restricted-item:true"];
  if (options.collection) clauses.push(`collection:${options.collection}`);
  const found = new Map<string, Candidate>();
  for (let page = 1; page <= pages; page++) {
    const params = new URLSearchParams({ q: clauses.join(" AND "), rows: "100", page: String(page), output: "json" });
    for (const field of ["identifier", "title", "creator", "year", "runtime", "licenseurl", "downloads", "description", "subject"]) params.append("fl[]", field);
    // Default server relevance, never popularity-first. Bound pagination deliberately.
    const body = await api.json<{ response?: { docs?: Record<string, unknown>[]; numFound?: number } }>(`${BASE}/advancedsearch.php?${params}`, 3_600_000, options.fresh);
    if (!body.response || !Array.isArray(body.response.docs)) throw new Error("Malformed search response");
    for (const doc of body.response.docs) {
      const identifier = strings(doc.identifier)[0], urls = strings(doc.licenseurl), rule = itemLicense(urls);
      if (!identifier || !rule || !allowed.includes(rule.id)) continue;
      const candidate: Candidate = { identifier, title: strings(doc.title).join("; ") || identifier,
        creator: strings(doc.creator).join("; ") || undefined, year: strings(doc.year)[0], runtime: strings(doc.runtime)[0],
        licenseUrl: urls[0], license: rule.label, attributionRequired: rule.attribution, detailsUrl: detailsUrl(identifier),
        thumbnailUrl: `${BASE}/services/img/${encodeURIComponent(identifier)}`, description: plainText(strings(doc.description).join(" ")).slice(0, 6000),
        subjects: strings(doc.subject), relevanceScore: 0, matchedTerms: [], warnings: [], downloads: Number(doc.downloads) || 0 };
      found.set(identifier, rankCandidate(candidate, options.visualIntent ?? options.query));
    }
    if (body.response.docs.length < 100 || page * 100 >= (body.response.numFound ?? Infinity)) break;
  }
  return [...found.values()].sort((a, b) => b.relevanceScore - a.relevanceScore || a.identifier.localeCompare(b.identifier)).slice(0, rows);
};
export const downloadFile = (identifier: string, file: ItemFile, destination: string) => client.download(identifier, file, destination);
