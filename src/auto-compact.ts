import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  DEFAULT_AUTO_COMPACT_CONFIG,
  MAX_AUTO_COMPACT_PERCENT,
  MIN_AUTO_COMPACT_PERCENT,
  loadAutoCompactConfig,
  saveAutoCompactConfig,
  type AutoCompactConfig,
} from "./config.js";
import { openSettingsMenu } from "./settings-menu.js";

const CONTINUATION_MESSAGE = "Context was compacted automatically. Continue the unfinished task from the compacted summary and recent messages without waiting for user input.";
const COMPACTION_INSTRUCTIONS = "Preserve the active goal, constraints, completed work, current work, blockers, errors, changed files, verification state, and exact next steps so work can continue immediately.";

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export const AUTO_COMPACT_PERCENT_VALUES = Array.from(
  { length: MAX_AUTO_COMPACT_PERCENT - MIN_AUTO_COMPACT_PERCENT + 1 },
  (_, index) => MIN_AUTO_COMPACT_PERCENT + index,
);

export function shouldTriggerAutoCompact(
  config: AutoCompactConfig,
  usage: ContextUsage | undefined,
  compactionPending: boolean,
): boolean {
  return config.enabled
    && !compactionPending
    && usage?.percent !== null
    && usage?.percent !== undefined
    && usage.percent >= config.thresholdPercent;
}

function parseThreshold(value: string): number | undefined {
  const threshold = Number(value.replace(/%$/, ""));
  return Number.isInteger(threshold)
    && threshold >= MIN_AUTO_COMPACT_PERCENT
    && threshold <= MAX_AUTO_COMPACT_PERCENT
    ? threshold
    : undefined;
}

function formatTokens(tokens: number): string {
  return `${Math.round(tokens / 100) / 10}K`;
}

function configSummary(config: AutoCompactConfig, ctx: ExtensionContext): string {
  const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
  const trigger = contextWindow
    ? `${config.thresholdPercent}% of ${formatTokens(contextWindow)} (${formatTokens(contextWindow * config.thresholdPercent / 100)})`
    : `${config.thresholdPercent}% of active model context`;
  return `continuous auto-compact: ${config.enabled ? "on" : "off"}, trigger ${trigger}`;
}

export function registerAutoCompact(pi: ExtensionAPI): void {
  let config: AutoCompactConfig = DEFAULT_AUTO_COMPACT_CONFIG;
  let compactionPending = false;

  const updateConfig = async (next: AutoCompactConfig): Promise<void> => {
    config = next;
    await saveAutoCompactConfig(config);
  };

  pi.registerCommand("autocompact", {
    description: "Configure continuous-loop context compaction",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "on", label: "on", description: "Enable continuous-loop compaction" },
        { value: "off", label: "off", description: "Disable continuous-loop compaction" },
        { value: "status", label: "status", description: "Show current configuration" },
        { value: "threshold", label: "threshold", description: "Select trigger percentage" },
        ...AUTO_COMPACT_PERCENT_VALUES.map((percent) => ({
          value: `threshold ${percent}`,
          label: `threshold ${percent}`,
          description: `Compact at ${percent}% of active model context`,
        })),
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

      if (parts.length === 0 && ctx.hasUI) {
        const items: SettingItem[] = [
          {
            id: "enabled",
            label: "Enabled",
            description: "Interrupt long agent loops, compact, and continue",
            currentValue: config.enabled ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "threshold",
            label: "Trigger usage",
            description: "Percentage of Pi active-model context limit",
            currentValue: `${config.thresholdPercent}%`,
            values: AUTO_COMPACT_PERCENT_VALUES.map((percent) => `${percent}%`),
          },
        ];

        await openSettingsMenu(ctx, items, async (id, newValue) => {
          if (id === "enabled") {
            await updateConfig({ ...config, enabled: newValue === "on" });
          } else if (id === "threshold") {
            const thresholdPercent = parseThreshold(newValue);
            if (thresholdPercent !== undefined) {
              await updateConfig({ ...config, thresholdPercent });
            }
          }
        });
        return;
      }

      if (parts[0] === "on" || parts[0] === "off") {
        await updateConfig({ ...config, enabled: parts[0] === "on" });
      } else if (parts[0] === "threshold" && !parts[1] && ctx.hasUI) {
        const selected = await ctx.ui.select(
          "Auto-compact trigger usage",
          AUTO_COMPACT_PERCENT_VALUES.map((percent) => `${percent}%`),
        );
        const thresholdPercent = selected ? parseThreshold(selected) : undefined;
        if (thresholdPercent !== undefined) {
          await updateConfig({ ...config, thresholdPercent });
        }
      } else if (parts[0] === "threshold" && parts[1]) {
        const thresholdPercent = parseThreshold(parts[1]);
        if (thresholdPercent === undefined) {
          ctx.ui.notify(`Threshold must be ${MIN_AUTO_COMPACT_PERCENT}-${MAX_AUTO_COMPACT_PERCENT}%.`, "error");
          return;
        }
        await updateConfig({ ...config, thresholdPercent });
      } else if (parts[0] !== "status") {
        ctx.ui.notify("Usage: /autocompact [on|off|status|threshold <50-99>]", "error");
        return;
      }

      ctx.ui.notify(configSummary(config, ctx), "info");
    },
  });

  pi.on("session_start", async () => {
    config = await loadAutoCompactConfig();
    compactionPending = false;
  });

  pi.on("turn_end", (event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || !shouldTriggerAutoCompact(config, usage, compactionPending)) return;

    compactionPending = true;
    const shouldContinue = event.toolResults.length > 0;
    ctx.ui.notify(
      `Context reached ${usage.percent.toFixed(1)}% of ${formatTokens(usage.contextWindow)}; compacting.`,
      "info",
    );

    ctx.compact({
      customInstructions: COMPACTION_INSTRUCTIONS,
      onComplete: () => {
        compactionPending = false;
        if (!shouldContinue) return;
        pi.sendMessage(
          {
            customType: "pi-openai-tweaks-autocompact",
            content: CONTINUATION_MESSAGE,
            display: false,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
      onError: (error) => {
        compactionPending = false;
        ctx.ui.notify(`Automatic compaction failed: ${error.message}`, "error");
      },
    });
  });

  pi.on("session_shutdown", () => {
    compactionPending = false;
  });
}
