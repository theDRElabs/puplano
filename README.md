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

The voice script caches unchanged ElevenLabs chunks, joins them into
`voice/narration.mp3`, and writes exact timings to `voice/words.json`.

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

The command validates the storyboard and word timings, rejects scene cuts that
are not on word boundaries, checks displayed numbers against the script, stages
project assets, and renders:

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

## Images, footage, and licenses

Media sourcing is intentionally provider-neutral: obtain a clip or image you
are allowed to use, place it under the project's `assets/` directory, and keep
its license and source URL in the storyboard. Puplano does not scrape a stock
provider or silently download unverified media.

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
      "credit": "Creator name"
    }
  }
}
```

The clip must be long enough for the scene after `startFromMs`; clips are not
looped. `image_zoom` follows the same license requirement. HTTPS media URLs are
supported, but local project assets are preferred for reproducible renders.

Music is optional. Add it under the project directory and reference it in the
storyboard's `music.file`. If an optional music file is absent, rendering emits
a warning and continues with narration only.
