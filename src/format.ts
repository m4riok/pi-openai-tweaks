import type { CodexUsageSnapshot, LimitWindow } from "./types.js";
import type { UsageDisplayConfig } from "./config.js";

type ColorName = "success" | "warning" | "error";

type Colorize = (color: ColorName, text: string) => string;

function pct(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "?%";
  return `${Math.round(value)}%`;
}

function displayPercent(window: LimitWindow | undefined, mode: UsageDisplayConfig["percentMode"]): string {
  if (!window) return "?%";
  return mode === "used" ? pct(window.usedPercent) : pct(window.leftPercent);
}

function remainingSeconds(window?: LimitWindow): number | undefined {
  if (!window) return undefined;
  if (window.resetAfterSeconds !== undefined && Number.isFinite(window.resetAfterSeconds)) {
    return Math.max(0, Math.round(window.resetAfterSeconds));
  }
  if (window.resetAt !== undefined && Number.isFinite(window.resetAt)) {
    return Math.max(0, Math.round(window.resetAt - Date.now() / 1000));
  }
  return undefined;
}

function formatHoursMinutes(totalSeconds?: number): string {
  if (totalSeconds === undefined) return "?";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h${m}m`;
}

function formatWeekly(totalSeconds?: number): string {
  if (totalSeconds === undefined) return "?";
  const days = totalSeconds / 86400;
  if (days >= 1) return `~${Math.round(days)}d`;
  return formatHoursMinutes(totalSeconds);
}

function colorForLeftPercent(leftPercent?: number): ColorName {
  if (leftPercent === undefined || !Number.isFinite(leftPercent)) return "warning";
  if (leftPercent >= 70) return "success";
  if (leftPercent >= 30) return "warning";
  return "error";
}

function colorForUsedPercent(usedPercent?: number): ColorName {
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return "warning";
  if (usedPercent >= 70) return "error";
  if (usedPercent >= 30) return "warning";
  return "success";
}

function colorForResetTime(remaining?: number, maxSeconds?: number): ColorName {
  if (remaining === undefined || maxSeconds === undefined || maxSeconds <= 0) return "warning";
  const ratio = Math.max(0, Math.min(1, remaining / maxSeconds));
  if (ratio >= 0.6) return "error";
  if (ratio >= 0.25) return "warning";
  return "success";
}

function maybeColor(text: string, color: ColorName, colorize?: Colorize): string {
  return colorize ? colorize(color, text) : text;
}

export function formatUsageStatusline(
  snapshot: CodexUsageSnapshot,
  colorize?: Colorize,
  config: UsageDisplayConfig = { format: "default", showWeekly: true, percentMode: "remaining", updateMode: "turn" },
): string {
  const primary = snapshot.defaultLimit?.primary;
  const secondary = snapshot.defaultLimit?.secondary;

  const pLeft = displayPercent(primary, config.percentMode);
  const sLeft = displayPercent(secondary, config.percentMode);

  const pResetSeconds = remainingSeconds(primary);
  const sResetSeconds = remainingSeconds(secondary);

  const pReset = formatHoursMinutes(pResetSeconds);
  const sReset = formatWeekly(sResetSeconds);

  const pPercentColor = config.percentMode === "used"
    ? colorForUsedPercent(primary?.usedPercent)
    : colorForLeftPercent(primary?.leftPercent);
  const sPercentColor = config.percentMode === "used"
    ? colorForUsedPercent(secondary?.usedPercent)
    : colorForLeftPercent(secondary?.leftPercent);

  const pLeftText = maybeColor(pLeft, pPercentColor, colorize);
  const sLeftText = maybeColor(sLeft, sPercentColor, colorize);
  const pctWord = config.percentMode === "used" ? "used" : "left";
  const pResetText = maybeColor(pReset, colorForResetTime(pResetSeconds, 5 * 3600), colorize);
  const sResetText = maybeColor(sReset, colorForResetTime(sResetSeconds, 7 * 24 * 3600), colorize);

  if (config.format === "compact") {
    if (!config.showWeekly) {
      return `U 5h:${pLeftText} ↺ ${pResetText}`;
    }
    return `U 5h:${pLeftText} ↺ ${pResetText} 7d:${sLeftText} ↺ ${sResetText}`;
  }

  if (!config.showWeekly) {
    return `Usage 5h:${pLeftText} ${pctWord} resets in ${pResetText}`;
  }

  return `Usage 5h:${pLeftText} ${pctWord} resets in ${pResetText}, 7d:${sLeftText} ${pctWord} resets in ${sResetText}`;
}
