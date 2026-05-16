import { readCachedSnapshot, writeCachedSnapshot, isFresh } from "./cache.js";
import { resolveAuth } from "./auth.js";
import { SCHEMA_VERSION } from "./types.js";
import type { CacheOptions, CodexUsageSnapshot, LimitWindow, RateLimit } from "./types.js";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/usage";
const CACHE_MAX_AGE_MS = 60_000;

type ApiWindow = {
  used_percent?: number;
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

function normalizeWindow(api?: ApiWindow | null): LimitWindow | undefined {
  if (!api) return undefined;
  const used = num(api.used_percent);
  if (used === undefined) return undefined;
  const clamped = Math.min(100, Math.max(0, used));
  return {
    usedPercent: clamped,
    leftPercent: Math.min(100, Math.max(0, 100 - clamped)),
    resetAt: num(api.reset_at),
    resetAfterSeconds: num(api.reset_after_seconds),
  };
}

function normalizeDefaultLimit(api?: ApiRateLimit | null): RateLimit | undefined {
  if (!api) return undefined;
  const primary = normalizeWindow(api.primary_window);
  const secondary = normalizeWindow(api.secondary_window);
  if (!primary && !secondary) return undefined;
  return { id: "codex", name: "Codex", primary, secondary };
}

async function fetchUsageFromApi(): Promise<CodexUsageSnapshot> {
  const auth = await resolveAuth("auto");
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

export async function getUsageSnapshot(options: CacheOptions = {}): Promise<CodexUsageSnapshot> {
  const maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS;
  if (!options.noCache) {
    const cached = await readCachedSnapshot();
    if (cached && isFresh(cached, maxAgeMs)) return { ...cached, source: "cache" };
  }

  const snapshot = await fetchUsageFromApi();
  await writeCachedSnapshot(snapshot).catch(() => undefined);
  return snapshot;
}
