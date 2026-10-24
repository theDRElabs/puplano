# Storyboard task

You turn a narration script into a storyboard JSON. Work only inside ~/puplano.
Do NOT edit anything except the one output file named below.

## Inputs (read these first)
1. projects/PROJECT/script/script.md  (the approved narration)
2. projects/PROJECT/voice/words.json  (every word with startMs and endMs, plus durationMs)
3. schemas/storyboard.ts  (the exact schema you must satisfy)
4. projects/demo/storyboard/good.json  (a valid example of the format)
5. scripts/validate-storyboard.ts  (read it to see how to run the validator)
6. projects/PROJECT/assets/  (available local media; it may be empty)

## Output
Write projects/PROJECT/storyboard/storyboard.json
PROJECT is the project name given in the prompt.

## Rules
- Scenes are back to back. First scene startMs is 0. Last scene endMs equals durationMs from words.json.
- Start and end each scene on word boundaries taken from words.json. Aim for 3000 to 9000 ms per scene.
- A scene's narration field is the exact words spoken during it.
- Choose the template from what is said: numbers use stat_counter or chart, dates in order use timeline, places use map, a spoken quote uses quote_cutout, section openers use kinetic_title, and licensed local footage may use video_clip.
- Never invent facts, numbers, quotes or sources. Use only what script.md says. If the script gives no data for a moment, use kinetic_title.
- Do not use image_zoom or video_clip, and leave out imageFile in quote_cutout, until the referenced files and their real license details are available in projects/PROJECT/assets.
- Vary layouts (1 to 3). Never put the same template and layout three times in a row.
- Increase chapter number when the topic changes. Start at 1.
- Add a source {label} only when a scene shows a fact or number, and an overlay of kind source_caption for it. The label must come from the script.
- title: a short title from the script. audioFile: voice/narration.mp3. Include music only when its referenced file exists in this project.

## Check your work
1. Run the validator on your output exactly as scripts/validate-storyboard.ts explains.
2. If it fails, fix the JSON and run it again. Stop after 5 attempts.
3. When it passes, reply with the scene count and any assumptions you made. Nothing else.
- Use timeline only when script.md names at least two different dates or years, and every date must come from the script. Otherwise use kinetic_title.
- After the validator passes, also run: python3 scripts/check-numbers.py PROJECT. If it prints NOT IN SCRIPT, fix those scenes and run both checks again.
