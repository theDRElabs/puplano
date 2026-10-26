import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StyleProfile } from "../schemas/style";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES_DIR = path.join(ROOT, "styles");

export const DEFAULT_STYLE_ID = "network-truecrime";

const availableStyles = (): string[] =>
  existsSync(STYLES_DIR)
    ? readdirSync(STYLES_DIR)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
        .sort()
    : [];

export const loadStyle = (id: string = DEFAULT_STYLE_ID): StyleProfile => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      `Invalid style id "${id}": use lowercase letters, digits, and hyphens`,
    );
  }

  const file = path.join(STYLES_DIR, `${id}.json`);
  if (!existsSync(file)) {
    const available = availableStyles();
    throw new Error(
      `Style "${id}" not found at styles/${id}.json` +
        (available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Style "${id}" is not valid JSON: ${message}`);
  }

  const result = StyleProfile.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Style "${id}" is invalid:\n${issues}`);
  }
  if (result.data.id !== id) {
    throw new Error(
      `Style "${id}" declares id "${result.data.id}" in styles/${id}.json`,
    );
  }
  return result.data;
};
