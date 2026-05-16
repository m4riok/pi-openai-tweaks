import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type UsageFormatMode = "default" | "compact";
export type PercentMode = "remaining" | "used";
export type UpdateMode = "turn" | "poll";

export interface UsageDisplayConfig {
  format: UsageFormatMode;
  showWeekly: boolean;
  percentMode: PercentMode;
  updateMode: UpdateMode;
}

const DEFAULT_CONFIG: UsageDisplayConfig = {
  format: "default",
  showWeekly: true,
  percentMode: "remaining",
  updateMode: "turn",
};

function settingsPath(): string {
  return join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "settings.json");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseConfig(raw: unknown): UsageDisplayConfig {
  if (!isObj(raw)) return DEFAULT_CONFIG;
  const format = raw.format === "compact" ? "compact" : "default";
  const showWeekly = raw.showWeekly !== false;
  const percentMode = raw.percentMode === "used" ? "used" : "remaining";
  const updateMode = raw.updateMode === "poll" ? "poll" : "turn";
  return { format, showWeekly, percentMode, updateMode };
}

export async function loadDisplayConfig(): Promise<UsageDisplayConfig> {
  try {
    const text = await readFile(settingsPath(), "utf8");
    const json = JSON.parse(text);
    if (!isObj(json)) return DEFAULT_CONFIG;
    return parseConfig(json.piOpenaiTweaks);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveDisplayConfig(next: UsageDisplayConfig): Promise<void> {
  const path = settingsPath();
  let json: Record<string, unknown> = {};
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    if (isObj(parsed)) json = parsed;
  } catch {
    // create/overwrite with minimal object
  }

  json.piOpenaiTweaks = {
    format: next.format,
    showWeekly: next.showWeekly,
    percentMode: next.percentMode,
    updateMode: next.updateMode,
  };

  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}
