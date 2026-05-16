import { readCachedSnapshot, writeCachedSnapshot, isFresh } from "./cache.js";
import { resolveAuth } from "./auth.js";
import { SCHEMA_VERSION } from "./types.js";
import type { CacheOptions, CodexUsageSnapshot, LimitWindow, RateLimit } from "./types.js";

export interface UsageAuthOverride {
  accessToken: string;
  accountId?: string;
  source?: string;
}

interface UsageSnapshotOptions extends CacheOptions {
  auth?: UsageAuthOverride;
}

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_MAX_AGE_MS = 60_000;

type ApiWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
};

type ApiRateLimit = {
  primary_window?: ApiWindow | null;
  secondary_window?: ApiWindow | null;
};

type ApiUsage = {
  email?: string;
  plan_type?: string;
  rate_limit?: ApiRateLimit | null;
  credits?: { balance?: string | number } | null;
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

function normalizeWindow(api?: ApiWindow | null): LimitWindow | undefined {
  if (!api) return undefined;

  const used = num(api.used_percent);
  if (used === undefined) return undefined;

  const usedPercent = Math.min(100, Math.max(0, used));
  return {
    usedPercent,
    leftPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
    resetAt: num(api.reset_at),
    resetAfterSeconds: num(api.reset_after_seconds),
  };
}

function windowSeconds(api?: ApiWindow | null): number | undefined {
  return num(api?.limit_window_seconds);
}

export function normalizeDefaultLimit(api?: ApiRateLimit | null): RateLimit | undefined {
  if (!api) return undefined;

  const windows = [api.primary_window, api.secondary_window];
  const fiveHourRaw = windows.find((w) => {
    const s = windowSeconds(w);
    return s !== undefined && Math.abs(s - FIVE_HOUR_SECONDS) <= 120;
  });
  const weeklyRaw = windows.find((w) => {
    const s = windowSeconds(w);
    return s !== undefined && Math.abs(s - WEEK_SECONDS) <= 120;
  });

  const primary = normalizeWindow(fiveHourRaw);
  const secondary = normalizeWindow(weeklyRaw);

  if (!primary && !secondary) return undefined;
  return { id: "codex", name: "Codex", primary, secondary };
}

async function fetchUsageFromApi(authOverride?: UsageAuthOverride): Promise<CodexUsageSnapshot> {
  const auth = authOverride ?? await resolveAuth("auto");
  const res = await fetch(USAGE_ENDPOINT, {
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      accept: "application/json",
      "user-agent": "pi-openai-tweaks/0.1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex usage request failed (${res.status}): ${body.slice(0, 240)}`);
  }

  const api = (await res.json()) as ApiUsage;

  return {
    schemaVersion: SCHEMA_VERSION,
    source: "api",
    fetchedAt: new Date().toISOString(),
    account: {
      email: str(api.email),
      plan: str(api.plan_type),
    },
    defaultLimit: normalizeDefaultLimit(api.rate_limit),
    credits: api.credits?.balance !== undefined ? { balance: String(api.credits.balance) } : undefined,
  };
}

export async function getUsageSnapshot(options: UsageSnapshotOptions = {}): Promise<CodexUsageSnapshot> {
  const maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS;
  const canUseCache = !options.auth && !options.noCache;
  if (canUseCache) {
    const cached = await readCachedSnapshot();
    if (cached && isFresh(cached, maxAgeMs)) return { ...cached, source: "cache" };
  }

  const snapshot = await fetchUsageFromApi(options.auth);
  if (!options.auth) await writeCachedSnapshot(snapshot).catch(() => undefined);
  return snapshot;
}
