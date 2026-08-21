import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type UsageFormatMode = "default" | "compact";
export type PercentMode = "remaining" | "used";
export type UpdateMode = "turn" | "poll";

export interface UsageDisplayConfig {
  format: UsageFormatMode;
  show5h: boolean;
  showWeekly: boolean;
  percentMode: PercentMode;
  updateMode: UpdateMode;
}

export interface AutoCompactConfig {
  enabled: boolean;
  thresholdPercent: number;
}

export const MIN_AUTO_COMPACT_PERCENT = 50;
export const MAX_AUTO_COMPACT_PERCENT = 99;

export const DEFAULT_USAGE_DISPLAY_CONFIG: UsageDisplayConfig = {
  format: "default",
  show5h: false,
  showWeekly: true,
  percentMode: "remaining",
  updateMode: "turn",
};

export const DEFAULT_AUTO_COMPACT_CONFIG: AutoCompactConfig = {
  enabled: false,
  thresholdPercent: 90,
};

function settingsPath(): string {
  return join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "settings.json");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseDisplayConfig(raw: unknown): UsageDisplayConfig {
  if (!isObj(raw)) return DEFAULT_USAGE_DISPLAY_CONFIG;
  const format = raw.format === "compact" ? "compact" : "default";
  const show5h = raw.show5h === true;
  const showWeekly = raw.showWeekly !== false;
  const percentMode = raw.percentMode === "used" ? "used" : "remaining";
  const updateMode = raw.updateMode === "poll" ? "poll" : "turn";
  return { format, show5h, showWeekly, percentMode, updateMode };
}

function parseAutoCompactConfig(raw: unknown): AutoCompactConfig {
  if (!isObj(raw)) return DEFAULT_AUTO_COMPACT_CONFIG;
  const threshold = raw.thresholdPercent;
  const thresholdPercent = Number.isInteger(threshold)
    && Number(threshold) >= MIN_AUTO_COMPACT_PERCENT
    && Number(threshold) <= MAX_AUTO_COMPACT_PERCENT
    ? Number(threshold)
    : DEFAULT_AUTO_COMPACT_CONFIG.thresholdPercent;
  return { enabled: raw.enabled === true, thresholdPercent };
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), "utf8"));
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extensionSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return isObj(settings.piOpenaiTweaks) ? settings.piOpenaiTweaks : {};
}

async function saveExtensionSettings(patch: Record<string, unknown>): Promise<void> {
  const settings = await readSettings();
  settings.piOpenaiTweaks = { ...extensionSettings(settings), ...patch };
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function loadDisplayConfig(): Promise<UsageDisplayConfig> {
  return parseDisplayConfig(extensionSettings(await readSettings()));
}

export async function saveDisplayConfig(next: UsageDisplayConfig): Promise<void> {
  await saveExtensionSettings({
    format: next.format,
    show5h: next.show5h,
    showWeekly: next.showWeekly,
    percentMode: next.percentMode,
    updateMode: next.updateMode,
  });
}

export async function loadAutoCompactConfig(): Promise<AutoCompactConfig> {
  const settings = extensionSettings(await readSettings());
  return parseAutoCompactConfig(settings.autoCompact);
}

export async function saveAutoCompactConfig(next: AutoCompactConfig): Promise<void> {
  await saveExtensionSettings({
    autoCompact: {
      enabled: next.enabled,
      thresholdPercent: next.thresholdPercent,
    },
  });
}
