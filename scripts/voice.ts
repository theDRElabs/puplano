import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.join(homedir(), "puplano");
const project = process.argv[2];
if (!project) { console.log("Usage: npx tsx scripts/voice.ts <project-name>"); process.exit(1); }

const dir = path.join(ROOT, "projects", project);
const config = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));

// Read the secret key from the keys file (it is never printed)
function loadKey(name: string): string {
  const text = readFileSync(path.join(homedir(), ".secrets", "pipeline.env"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith(name + "="));
  const value = line ? line.slice(name.length + 1).trim() : "";
  if (!value) throw new Error(`${name} is empty in ~/.secrets/pipeline.env`);
  return value;
}
const KEY = loadKey("ELEVENLABS_API_KEY");
const API = "https://api.elevenlabs.io/v1";

// Find the voice ID by its name (for example "Alice")
async function findVoiceId(name: string): Promise<string> {
  const res = await fetch(`${API}/voices`, { headers: { "xi-api-key": KEY } });
  if (!res.ok) throw new Error(`Could not list voices: HTTP ${res.status}`);
  const data: any = await res.json();
  const match = data.voices.find((v: any) => v.name.split(" - ")[0].toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`No voice named "${name}" on this account`);
  return match.voice_id;
}

// Read script.md and drop markdown headings
function readScript(): string {
  const file = path.join(dir, "script", "script.md");
  if (!existsSync(file)) throw new Error(`Missing ${file}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();
}

// Split text into chunks of at most maxChars, cutting at paragraph or sentence ends
function splitText(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (p.length <= maxChars) { pieces.push(p); continue; }
    for (const s of p.split(/(?<=[.!?]["')\]]?)\s+/)) pieces.push(s);
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && (current + " " + piece).length > maxChars) { chunks.push(current); current = piece; }
    else current = current ? current + " " + piece : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

type Word = { word: string; startMs: number; endMs: number };

// Send one chunk to ElevenLabs, save its audio, return word timings
async function speakChunk(voiceId: string, text: string, prev: string, next: string, outFile: string): Promise<{ words: Word[]; durationMs: number }> {
  const body: any = { text, model_id: config.modelId };
  if (prev) body.previous_text = prev;
  if (next) body.next_text = next;
  const res = await fetch(`${API}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ElevenLabs error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  if (!data.alignment) throw new Error("ElevenLabs returned no timing data");
  writeFileSync(outFile, Buffer.from(data.audio_base64, "base64"));

  // Turn character timings into word timings
  const chars: string[] = data.alignment.characters;
  const starts: number[] = data.alignment.character_start_times_seconds;
  const ends: number[] = data.alignment.character_end_times_seconds;
  const words: Word[] = [];
  let cur = "", s = 0, e = 0;
  const flush = () => { if (cur) words.push({ word: cur, startMs: Math.round(s * 1000), endMs: Math.round(e * 1000) }); cur = ""; };
  chars.forEach((c, i) => {
    if (/\s/.test(c)) flush();
    else { if (!cur) s = starts[i]; cur += c; e = ends[i]; }
  });
  flush();

  // Real length of the saved audio file
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outFile]);
  return { words, durationMs: Math.round(Number(probe.toString().trim()) * 1000) };
}

async function main() {
  const text = readScript();
  const chunks = splitText(text, config.maxChunkChars);
  const voiceDir = path.join(dir, "voice");
  mkdirSync(voiceDir, { recursive: true });
  console.log(`Script: ${text.length} characters, ${chunks.length} chunk(s)`);

  const voiceId = await findVoiceId(config.voiceName);
  const allWords: Word[] = [];
  const files: string[] = [];
  let offset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const n = String(i + 1).padStart(3, "0");
    const audio = path.join(voiceDir, `chunk-${n}.mp3`);
    const meta = path.join(voiceDir, `chunk-${n}.json`);
    const prev = i > 0 ? chunks[i - 1].slice(-300) : "";
    const next = i < chunks.length - 1 ? chunks[i + 1].slice(0, 300) : "";
    let result: { words: Word[]; durationMs: number };

    const cached = existsSync(audio) && existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")) : null;
    if (cached && cached.text === chunks[i] && cached.voiceName === config.voiceName && cached.modelId === config.modelId) {
      console.log(`Chunk ${i + 1}/${chunks.length}: reusing saved audio (no credits used)`);
      result = cached.result;
    } else {
      console.log(`Chunk ${i + 1}/${chunks.length}: generating (${chunks[i].length} characters)`);
      result = await speakChunk(voiceId, chunks[i], prev, next, audio);
      writeFileSync(meta, JSON.stringify({ text: chunks[i], voiceName: config.voiceName, modelId: config.modelId, result }));
    }
    for (const w of result.words) allWords.push({ word: w.word, startMs: w.startMs + offset, endMs: w.endMs + offset });
    files.push(audio);
    offset += result.durationMs;
  }

  // Join all chunk audio into one narration file
  const listFile = path.join(voiceDir, "concat.txt");
  writeFileSync(listFile, files.map((f) => `file '${f}'`).join("\n") + "\n");
  const out = path.join(voiceDir, "narration.mp3");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libmp3lame", "-b:a", "128k", out]);
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
  const durationMs = Math.round(Number(probe.toString().trim()) * 1000);
  const timingToleranceMs = 100;
  const badTiming = allWords.find(
    (word) => word.startMs >= durationMs || word.endMs > durationMs + timingToleranceMs,
  );
  if (badTiming) {
    throw new Error(
      `Word timing for "${badTiming.word}" runs outside the final audio duration`,
    );
  }
  const normalizedWords = allWords.map((word) => ({
    ...word,
    endMs: Math.min(word.endMs, durationMs),
  }));

  writeFileSync(path.join(voiceDir, "words.json"), JSON.stringify({ voiceName: config.voiceName, durationMs, words: normalizedWords }, null, 2));
  console.log(`Done: ${normalizedWords.length} words, ${(durationMs / 1000).toFixed(1)} seconds`);
  console.log(`Audio: ${out}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
