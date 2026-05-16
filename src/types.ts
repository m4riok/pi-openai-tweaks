export const SCHEMA_VERSION = 1;

export type AuthSource = "auto" | "pi" | "codex";

export interface LimitWindow {
  usedPercent: number;
  leftPercent: number;
  resetAt?: number;
  resetAfterSeconds?: number;
}

export interface RateLimit {
  id: string;
  name: string;
  primary?: LimitWindow;
  secondary?: LimitWindow;
}

export interface AccountSnapshot {
  email?: string;
  plan?: string;
}

export interface CreditsSnapshot {
  balance?: string;
}

export interface CodexUsageSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "api" | "cache";
  fetchedAt: string;
  account: AccountSnapshot;
  defaultLimit?: RateLimit;
  credits?: CreditsSnapshot;
}

export interface CacheOptions {
  maxAgeMs?: number;
  noCache?: boolean;
}

export interface AuthCredentials {
  source: "pi" | "codex";
  path: string;
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresAtMs?: number;
}
