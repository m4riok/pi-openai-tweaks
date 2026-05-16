import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getUsageSnapshot, type UsageAuthOverride } from "./usage.js";
import { formatUsageStatusline } from "./format.js";
import { extractClaims } from "./jwt.js";
import { loadDisplayConfig, saveDisplayConfig, type UsageDisplayConfig } from "./config.js";

const STATUS_KEY = "usage";
const FAST_STATUS_KEY = "fast";
const CACHE_TTL_MS = 60_000;
const POLL_INTERVAL_MS = 60_000;

const FAST_PROVIDER_ID = "openai-codex";
const FAST_API_ID = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";
const FAST_MODELS = new Set(["gpt-5.4", "gpt-5.5"]);

type FastOverride = "auto" | "on" | "off";

function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function findProjectFastConfig(cwd: string): string {
  let current = cwd;
  while (true) {
    const candidate = join(current, ".pi", "openai-fast.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return join(cwd, ".pi", "openai-fast.json");
    current = parent;
  }
}

function loadFastConfigEnabled(cwd: string): boolean {
  const globalCfg = readJsonConfig(join(getAgentDir(), "extensions", "openai-fast.json"));
  const projectCfg = readJsonConfig(findProjectFastConfig(cwd));
  const globalEnabled = typeof globalCfg.enabled === "boolean" ? globalCfg.enabled : false;
  return typeof projectCfg.enabled === "boolean" ? projectCfg.enabled : globalEnabled;
}

function setStatus(ctx: any, text?: string): void {
  if (!ctx?.ui?.setStatus) return;
  if (typeof text !== "string") {
    ctx.ui.setStatus(STATUS_KEY, text);
    return;
  }
  // Ensure status text always starts from a known color state.
  ctx.ui.setStatus(STATUS_KEY, `\u001b[0m\u001b[37m${text}`);
}


function isFastEligible(ctx: any): boolean {
  const model = ctx?.model;
  if (!model) return false;
  if (model.provider !== FAST_PROVIDER_ID) return false;
  if (model.api !== FAST_API_ID) return false;
  if (!FAST_MODELS.has(model.id)) return false;
  try {
    return !!ctx?.modelRegistry?.isUsingOAuth?.(model);
  } catch {
    return false;
  }
}

function isOpenAICodexProvider(provider: unknown): boolean {
  return typeof provider === "string" && (provider === FAST_PROVIDER_ID || /^openai-codex-\d+$/.test(provider));
}

function updateFastStatus(ctx: any, enabled: boolean): void {
  if (!ctx?.ui?.setStatus) return;
  if (!enabled || !isFastEligible(ctx)) {
    ctx.ui.setStatus(FAST_STATUS_KEY, undefined);
    return;
  }

  const fg = ctx?.ui?.theme?.fg;
  const badgeRaw = "⚡ fast ⚡";
  if (typeof fg === "function") {
    try {
      ctx.ui.setStatus(FAST_STATUS_KEY, fg("success", badgeRaw));
      return;
    } catch {
      // fall through
    }
  }
  ctx.ui.setStatus(FAST_STATUS_KEY, `\u001b[38;5;114m${badgeRaw}\u001b[0m`);
}

async function getModelUsageAuth(ctx: any): Promise<UsageAuthOverride | undefined> {
  const model = ctx?.model;
  const registry = ctx?.modelRegistry;
  if (!model || typeof registry?.getApiKeyAndHeaders !== "function") return undefined;
  if (!isOpenAICodexProvider(model.provider)) return undefined;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) return undefined;

  const claims = extractClaims(auth.apiKey);
  return { accessToken: auth.apiKey, accountId: claims.accountId, source: "model" };
}

async function refreshStatus(ctx: any, display: UsageDisplayConfig, fastMode: boolean, noCache = false): Promise<string> {
  const modelAuth = await getModelUsageAuth(ctx).catch(() => undefined);
  const snapshot = await getUsageSnapshot({ maxAgeMs: CACHE_TTL_MS, noCache: noCache || !!modelAuth, auth: modelAuth });
  const colorize = (color: "success" | "warning" | "error", text: string): string => {
    const fg = ctx?.ui?.theme?.fg;
    if (typeof fg === "function") {
      try {
        return fg(color, text);
      } catch {
        // fall through to ANSI fallback
      }
    }

    const ansi =
      color === "success"
        ? "\u001b[38;5;114m"
        : color === "warning"
          ? "\u001b[38;5;214m"
          : "\u001b[38;5;203m";
    return `${ansi}${text}\u001b[0m`;
  };
  const line = formatUsageStatusline(snapshot, colorize, display);
  setStatus(ctx, line);
  updateFastStatus(ctx, fastMode);
  return line;
}

export default function usageExtension(pi: ExtensionAPI): void {
  let display: UsageDisplayConfig = { format: "default", showWeekly: true, percentMode: "remaining", updateMode: "turn" };
  let fastConfigEnabled = false;
  let fastOverride: FastOverride = "auto";
  let pollTimer: NodeJS.Timeout | undefined;
  let currentCtx: any;

  const isFastEnabled = (): boolean => {
    if (fastOverride === "on") return true;
    if (fastOverride === "off") return false;
    return fastConfigEnabled;
  };

  const stopPolling = (): void => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const syncPolling = (): void => {
    stopPolling();
    if (display.updateMode !== "poll" || !currentCtx) return;
    pollTimer = setInterval(() => {
      void refreshStatus(currentCtx, display, isFastEnabled(), true).catch(() => undefined);
    }, POLL_INTERVAL_MS);
  };

  pi.registerCommand("fast", {
    description: "Toggle OpenAI fast mode (service_tier=priority)",
    handler: async (args: string, ctx: any) => {
      const cmd = String(args || "").trim().toLowerCase();
      const eligible = isFastEligible(ctx);

      if (cmd === "on") {
        if (!eligible) {
          ctx.ui?.notify?.("Fast mode is not supported for the current model/provider/auth.", "error");
          await refreshStatus(ctx, display, isFastEnabled(), false);
          return;
        }
        fastOverride = "on";
      } else if (cmd === "off") {
        fastOverride = "off";
      } else if (cmd === "auto") {
        fastOverride = "auto";
        fastConfigEnabled = loadFastConfigEnabled(ctx.cwd);
        if (isFastEnabled() && !eligible) {
          ctx.ui?.notify?.("Fast auto-config is on, but this model is not eligible right now.", "warning");
        }
      } else if (cmd === "status") {
        const eligibility = eligible ? "eligible" : "ineligible";
        const mode = fastOverride === "auto" ? `auto(${fastConfigEnabled ? "on" : "off"})` : fastOverride;
        ctx.ui?.notify?.(`fast mode: ${isFastEnabled() ? "on" : "off"} ${mode} (${eligibility})`, "info");
        await refreshStatus(ctx, display, isFastEnabled(), false);
        return;
      } else {
        if (isFastEnabled()) {
          fastOverride = "off";
        } else {
          if (!eligible) {
            ctx.ui?.notify?.("Fast mode is not supported for the current model/provider/auth.", "error");
            await refreshStatus(ctx, display, isFastEnabled(), false);
            return;
          }
          fastOverride = "on";
        }
      }

      await refreshStatus(ctx, display, isFastEnabled(), false);
      const eligibility = eligible ? "eligible" : "ineligible";
      ctx.ui?.notify?.(`fast mode ${isFastEnabled() ? "enabled" : "disabled"} (${eligibility})`, "info");
    },
  });

  pi.registerCommand("usage", {
    description: "Show compact OpenAI/Codex usage status",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "refresh", label: "refresh", description: "Bypass local cache" },
        { value: "format", label: "format", description: "Open format selector" },
        { value: "weekly", label: "weekly", description: "Open weekly selector" },
        { value: "format default", label: "format default", description: "Verbose status format" },
        { value: "format compact", label: "format compact", description: "Short status format" },
        { value: "weekly on", label: "weekly on", description: "Show 7d window" },
        { value: "weekly off", label: "weekly off", description: "Hide 7d window" },
        { value: "percent remaining", label: "percent remaining", description: "Show % remaining" },
        { value: "percent used", label: "percent used", description: "Show % used" },
        { value: "update turn", label: "update turn", description: "Update on each turn" },
        { value: "update poll", label: "update poll", description: "Update by polling" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: any) => {
      try {
        const input = String(args || "").trim();
        const parts = input.split(/\s+/).filter(Boolean);

        if (parts.length === 0 && ctx?.ui?.custom) {
          await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: (value?: unknown) => void) => {
            const items: SettingItem[] = [
              { id: "format", label: "Format", description: "Statusline format", currentValue: display.format, values: ["default", "compact"] },
              { id: "weekly", label: "Show weekly", description: "Show/hide 7d usage window", currentValue: display.showWeekly ? "on" : "off", values: ["on", "off"] },
              { id: "percent", label: "Percent mode", description: "Show percentage used vs remaining", currentValue: display.percentMode, values: ["remaining", "used"] },
              { id: "update", label: "Update mode", description: "Refresh on turn or polling interval", currentValue: display.updateMode, values: ["turn", "poll"] },
            ];

            const container = new Container();
            container.addChild(new DynamicBorder());

            const settingsList = new SettingsList(
              items,
              10,
              getSettingsListTheme(),
              async (id: string, newValue: string) => {
                if (id === "format" && (newValue === "default" || newValue === "compact")) display = { ...display, format: newValue };
                else if (id === "weekly") display = { ...display, showWeekly: newValue === "on" };
                else if (id === "percent" && (newValue === "remaining" || newValue === "used")) display = { ...display, percentMode: newValue };
                else if (id === "update" && (newValue === "turn" || newValue === "poll")) display = { ...display, updateMode: newValue };

                await saveDisplayConfig(display);
                syncPolling();
                await refreshStatus(ctx, display, isFastEnabled(), false);
              },
              () => done(undefined),
              { enableSearch: true },
            );

            container.addChild(settingsList);
            container.addChild(new DynamicBorder());

            return {
              render: (width: number) => container.render(width),
              invalidate: () => container.invalidate(),
              handleInput: (data: string) => {
                settingsList.handleInput?.(data);
                tui.requestRender();
              },
            };
          });

          await refreshStatus(ctx, display, isFastEnabled(), false);
          return;
        }

        if (parts[0] === "format" && !parts[1] && ctx?.ui?.select) {
          const formatChoice = await ctx.ui.select("Usage format", ["default", "compact"]);
          if (formatChoice === "default" || formatChoice === "compact") {
            display = { ...display, format: formatChoice };
            await saveDisplayConfig(display);
          }
          const line = await refreshStatus(ctx, display, isFastEnabled(), false);
          ctx.ui?.notify?.(line, "info");
          return;
        }

        if (parts[0] === "weekly" && !parts[1] && ctx?.ui?.select) {
          const weeklyChoice = await ctx.ui.select("Show weekly (7d)", ["on", "off"]);
          if (weeklyChoice === "on" || weeklyChoice === "off") {
            display = { ...display, showWeekly: weeklyChoice === "on" };
            await saveDisplayConfig(display);
          }
          const line = await refreshStatus(ctx, display, isFastEnabled(), false);
          ctx.ui?.notify?.(line, "info");
          return;
        }

        if (parts[0] === "format" && (parts[1] === "default" || parts[1] === "compact")) {
          display = { ...display, format: parts[1] };
          await saveDisplayConfig(display);
        } else if (parts[0] === "weekly" && (parts[1] === "on" || parts[1] === "off")) {
          display = { ...display, showWeekly: parts[1] === "on" };
          await saveDisplayConfig(display);
        } else if (parts[0] === "percent" && (parts[1] === "remaining" || parts[1] === "used")) {
          display = { ...display, percentMode: parts[1] };
          await saveDisplayConfig(display);
        } else if (parts[0] === "update" && (parts[1] === "turn" || parts[1] === "poll")) {
          display = { ...display, updateMode: parts[1] };
          await saveDisplayConfig(display);
        }

        syncPolling();
        const line = await refreshStatus(ctx, display, isFastEnabled(), parts[0] === "refresh");
        ctx.ui?.notify?.(line, "info");
      } catch (error) {
        ctx.ui?.notify?.(`Usage unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    try {
      display = await loadDisplayConfig();
      fastConfigEnabled = loadFastConfigEnabled(ctx.cwd);
      fastOverride = "auto";
      syncPolling();
      await refreshStatus(ctx, display, isFastEnabled());
    } catch {
      // ignore startup failures
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    updateFastStatus(ctx, isFastEnabled());
    if (!isFastEnabled() || !isFastEligible(ctx)) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const current = payload as Record<string, unknown>;
    if ("service_tier" in current) return;
    if (current.model !== ctx?.model?.id) return;
    return { ...current, service_tier: FAST_SERVICE_TIER };
  });

  pi.on("model_select", async (_event, ctx) => {
    updateFastStatus(ctx, isFastEnabled());
  });

  pi.on("after_provider_response", async (_event, ctx) => {
    if (display.updateMode !== "turn") {
      updateFastStatus(ctx, isFastEnabled());
      return;
    }
    try {
      await refreshStatus(ctx, display, isFastEnabled());
    } catch {
      // ignore async failures
    }
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
  });
}
