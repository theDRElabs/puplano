# Puplano

Puplano turns a narration script into a timed, source-aware Remotion video.
Each project keeps its script, generated voice track, storyboard, licensed media,
and renders together.

## Requirements

- Node.js and npm
- Python 3
- FFmpeg and FFprobe
- An ElevenLabs API key in `~/.secrets/pipeline.env` for voice generation:

```text
ELEVENLABS_API_KEY=...
```

Install both sets of dependencies:

```bash
npm install
npm install --prefix remotion
```

## Project structure

```text
projects/<project>/
├── script/script.md
├── voice/
│   ├── narration.mp3
│   └── words.json
├── storyboard/storyboard.json
├── assets/
└── renders/
```

Storyboard media paths are relative to the project directory. For example,
`assets/interview.mp4` resolves to
`projects/<project>/assets/interview.mp4`. Absolute paths and paths containing
`..` are rejected. Required media must exist before rendering.

## Workflow

### 1. Generate voice and word timings

```bash
npm run voice -- <project>
```

The voice script caches unchanged ElevenLabs segments, joins them into
`voice/narration.mp3`, and writes exact timings to `voice/words.json`. Each
word gets a stable id (`w0001`, `w0002`, ...) assigned from its global position
in the joined narration. Storyboard anchors reference those ids, not raw text
or punctuation.

### Voice pacing

Narration is synthesized in short sentence/paragraph segments at the speed in
`config.json` (0.95 by default). A deterministic pause plan inserts measured
silence at segment seams and after the final word. The join uses decoded WAV
durations, so `voice/words.json` stays aligned with the final MP3.

```bash
npm run voice -- <project> --style network-truecrime
npm run voice -- <project> --style network-truecrime --speed 0.95
npm run voice -- <project> --style network-truecrime --dry-run
```

`--dry-run` writes `voice/pacing-plan.json` without calling ElevenLabs and
prints the segment count, pause budget, estimate, and silence ratio. A real run
writes `voice/pacing-report.json` with the style targets, measured values, pass
flags, and per-seam pause plan. `--strict` exits nonzero when a target misses;
without it the run warns and still writes the report. A voice run leaves the
storyboard untouched, so re-time the storyboard after any voice or script
change.

### Timing compilation

Storyboard timing is compiled from word ids instead of hand-edited
milliseconds. A scene can carry:

```json
{
  "anchor": { "startWordId": "w0034", "endWordId": "w0041" },
  "holdMs": 250
}
```

The anchor must resolve to the scene's exact `narration` tokens, and the scene
must end on sentence punctuation. The compiler places the cut after the last
word, adds the authored hold and an 80 ms pad, clamps it inside the following
silence gap with a one-frame guard, and quantizes it to the 30 fps grid. Holds
are reduced when the following pause is too short; the report records requested
and effective values. Scenes stay contiguous, `durationMs` comes from the audio,
and cuts are never allowed inside a word.

Overlays can use a word span, a `{ "startSceneId": "s8", "endSceneId": "s8" }`
scene span, or `"span": "full"` for the whole track. Their millisecond fields
are rewritten from the compiled timing.

```bash
npm run compile-timing -- truecrime --style network-truecrime
# infer anchors from each scene's narration, then compile and write them:
npm run compile-timing -- truecrime --style network-truecrime --write-anchors
```

The command writes `storyboard/storyboard.json` and
`storyboard/timing-report.json` only after a successful compilation. The report
contains before/after pacing metrics, per-boundary requested/effective holds,
four arc metrics, style targets, and warnings. Style-target misses are warnings
for a later scene-splitting pass; the compiler still enforces contiguous
timing, `minShotMs`, and a sentence-end cut share of at least 0.60.

Use `--baseline <git-ref>` when re-timing an existing project: the report's
before block is measured against that ref's storyboard and narration timings
(for example, `--baseline fbfc537` for the current truecrime migration).

Re-timing does not invalidate a reviewed footage selection, because selection
hashes cover the scene id and narration rather than milliseconds. Coverage is
checked separately: `npm run source-media -- <project> verify` fails if a
compiled scene is longer than its clip, so extend or re-select footage when a
shot needs more screen time.

When narration changes, regenerate `voice/words.json` (which refreshes the
word ids) and recompile the storyboard. Normal renders use the committed
anchors and never tokenize narration at runtime.

### 2. Create the storyboard

Use `STORYBOARD-TASK.md` as the agent task. The output must be:

```text
projects/<project>/storyboard/storyboard.json
```

Validate it independently when needed:

```bash
npm run validate -- projects/<project>/storyboard/storyboard.json
npm run check-numbers -- <project>
```

### 3. Render

```bash
npm run render -- <project>
```

The command validates the storyboard and word timings, requires scene cuts in
silence gaps (never inside a word) with 30 fps-quantized timing, checks
displayed numbers against the script, stages project assets, and renders:

```text
projects/<project>/renders/final.mp4
```

Useful options:

```bash
npm run render -- <project> --scale 0.5
npm run render -- <project> --output projects/<project>/renders/review.mp4
```

Narration is embedded automatically. If music exists, it loops, fades at both
ends, and ducks while narration is active. Word timings also drive synchronized
phrase captions with active-word highlighting.

### Style profiles

Render style is data, not code. Profiles live in `styles/<id>.json` and are
validated by `schemas/style.ts`. A profile controls fps, frame dimensions,
palette, typography, grade targets, pacing targets, and caption limits.

```bash
npm run render -- <project> --style clean-explainer
```

`--style` defaults to `network-truecrime`. The profile supplies the video fps
(Remotion derives frame timing and duration from it), width, height, palette,
typography, and caption limits. Storyboard timings, media, and audio are not
changed by a style. Use `--frames 430-460` to render a short slice for visual
checks.

## Images, footage, and licenses

Media sourcing is provider-neutral by default: obtain a clip or image you are
allowed to use, place it under the project's `assets/` directory, and keep its
license and source URL in the storyboard. Puplano does not silently download
unverified media.

### Automated Archive.org sourcing

Puplano uses Archive.org's official advanced-search, metadata, and download APIs.
Discovery is metadata-based; it never proves that footage is visually relevant.
The workflow therefore requires contact-sheet review and an explicit time range
before a clip can be attached to a scene.

```bash
# Create scene-specific visual briefs, then edit media/shot-plan.json.
npm run source-media -- <project> plan

# Search every outstanding brief, or run one focused search.
npm run source-media -- <project> discover --collection prelinger --rows 12 --pages 2
npm run source-media -- <project> search 'police AND investigation' --scene s4 --rows 12

# Download the exact derivative named in Archive.org metadata.
npm run source-media -- <project> download <identifier> --file <remote.mp4>

# Generate timestamped beginning/middle/end contact sheets (times are seconds).
npm run source-media -- <project> preview <originalAssetId> --skip-intro 15 --max-shots 60

# Record a human/agent review of the uploader's rights claim.
npm run source-media -- <project> approve <originalAssetId> \
  --reviewer '<name>' \
  --evidence 'https://archive.org/details/<identifier>,<license-url>' \
  --note '<what was reviewed and limits of the approval>' \
  --jurisdiction US --credit '<creator>'

# Select only a visually reviewed shot that covers the complete scene.
npm run source-media -- <project> select <originalAssetId> <sceneId> \
  --shot shot-012 --start 123.4 --end 130.1 \
  --reviewer '<name>' --reason '<scene-specific visual reason>'

# Patch by derived clip ID—not item ID or whole film—and verify everything.
npm run source-media -- <project> patch <clipAssetId>
npm run source-media -- <project> verify
```

Search defaults to public-domain, CC0, and CC BY claims. CC BY-SA is available
only with `--include-share-alike` and requires a recorded distribution plan at
approval. NC, ND, malformed, conflicting, missing, restricted, dark, private,
and no-download sources are rejected. A license URL is uploader-supplied
metadata—not legal verification or an Archive.org guarantee.

The manifest keeps originals, derived clips, checksums, FFprobe results, exact
remote filenames, transformations, review notes, and clip lineage separately.
Generated preview pages stay local; the chosen three-frame contact sheet is
preserved under `media/reviews/` as durable review evidence. `media/credits.md`
contains complete attribution and modification details. Rendering rechecks the
manifest, source/clip checksums, selected evidence, scene coverage, and
attribution before staging assets.

Requests use `Puplano/0.2 (source-media)` and serialize through a shared rate
lock. Set `PUPLANO_UA_SUFFIX` to identify the executing agent/model, for example
`PUPLANO_UA_SUFFIX='(gpt-5.6-sol)'`. Successful API responses are cached;
transient responses and interrupted transfers are retried with bounded backoff,
timeouts, `Retry-After` support, and full checksum validation.

To preserve an older one-item manifest while separating its original and
unreviewed derivative, use:

```bash
npm run source-media -- <project> migrate <identifier> \
  --file <exact-remote-file> --original <project-relative-original-file>
```

Licensed footage uses the `video_clip` template:

```json
{
  "id": "s10",
  "chapter": 3,
  "startMs": 30000,
  "endMs": 36000,
  "layout": 1,
  "template": "video_clip",
  "props": {
    "videoFile": "assets/city.mp4",
    "caption": "A caption supported by the narration",
    "startFromMs": 2000,
    "license": {
      "type": "Pexels license",
      "sourceUrl": "https://www.pexels.com/video/example",
      "credit": "Creator name",
      "licenseUrl": "https://www.pexels.com/license/",
      "attribution": "Example clip — Creator name, Pexels license. Source: https://www.pexels.com/video/example",
      "modifications": "Excerpt 12.0–20.0s; trimmed, audio removed, re-encoded."
    }
  }
}
```

Every media license must carry `licenseUrl`, `attribution`, and
`modifications`; claims that require attribution also require `credit`.
Validation, rendering, and `source-media verify` reject incomplete attribution
before staging assets.

The clip must be long enough for the scene after `startFromMs`; clips are not
looped. `image_zoom` follows the same license requirement. HTTPS media URLs are
supported, but local project assets are preferred for reproducible renders.

Music is optional. Add it under the project directory and reference it in the
storyboard's `music.file`. If an optional music file is absent, rendering emits
a warning and continues with narration only.
