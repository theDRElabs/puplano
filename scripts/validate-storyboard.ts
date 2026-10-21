import { readFileSync } from "node:fs";
import { Storyboard } from "../schemas/storyboard";

const file = process.argv[2];
if (!file) { console.log("Usage: npx tsx scripts/validate-storyboard.ts <file.json>"); process.exit(1); }

const result = Storyboard.safeParse(JSON.parse(readFileSync(file, "utf8")));
if (result.success) {
  console.log(`OK: ${result.data.scenes.length} scenes, ${result.data.overlays.length} overlays`);
} else {
  console.log("REJECTED:");
  for (const issue of result.error.issues) console.log(`- ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}
