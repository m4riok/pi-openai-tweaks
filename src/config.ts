import { isObject, readSettings, updateSettings } from "./settings-store.js";

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

function parseDisplayConfig(raw: Record<string, unknown>): UsageDisplayConfig {
  const format = raw.format === "compact" ? "compact" : "default";
  const show5h = raw.show5h === true;
  const showWeekly = raw.showWeekly !== false;
  const percentMode = raw.percentMode === "used" ? "used" : "remaining";
  const updateMode = raw.updateMode === "poll" ? "poll" : "turn";
  return { format, show5h, showWeekly, percentMode, updateMode };
}

function parseAutoCompactConfig(raw: Record<string, unknown>): AutoCompactConfig {
  const threshold = raw.thresholdPercent;
  const thresholdPercent = Number.isInteger(threshold)
    && Number(threshold) >= MIN_AUTO_COMPACT_PERCENT
    && Number(threshold) <= MAX_AUTO_COMPACT_PERCENT
    ? Number(threshold)
    : DEFAULT_AUTO_COMPACT_CONFIG.thresholdPercent;
  return { enabled: raw.enabled === true, thresholdPercent };
}

function settingsObject(raw: unknown, name: string): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error(`${name} must contain a JSON object`);
  return raw;
}

export async function loadDisplayConfig(): Promise<UsageDisplayConfig> {
  return parseDisplayConfig(settingsObject((await readSettings()).piOpenaiTweaks, "piOpenaiTweaks"));
}

export async function saveDisplayConfig(patch: Partial<UsageDisplayConfig>): Promise<UsageDisplayConfig> {
  return updateSettings((settings) => {
    const next = { ...settingsObject(settings.piOpenaiTweaks, "piOpenaiTweaks"), ...patch };
    settings.piOpenaiTweaks = next;
    return parseDisplayConfig(next);
  });
}

export async function loadAutoCompactConfig(): Promise<AutoCompactConfig> {
  const extension = settingsObject((await readSettings()).piOpenaiTweaks, "piOpenaiTweaks");
  return parseAutoCompactConfig(settingsObject(extension.autoCompact, "piOpenaiTweaks.autoCompact"));
}

export async function saveAutoCompactConfig(patch: Partial<AutoCompactConfig>): Promise<AutoCompactConfig> {
  return updateSettings((settings) => {
    const extension = settingsObject(settings.piOpenaiTweaks, "piOpenaiTweaks");
    const autoCompact = { ...settingsObject(extension.autoCompact, "piOpenaiTweaks.autoCompact"), ...patch };
    settings.piOpenaiTweaks = { ...extension, autoCompact };
    return parseAutoCompactConfig(autoCompact);
  });
}
