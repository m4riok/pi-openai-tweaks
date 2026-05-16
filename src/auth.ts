import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractClaims } from "./jwt.js";
import type { AuthCredentials, AuthSource } from "./types.js";

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

function homePath(relativePath: string): string {
  return join(process.env.HOME || process.env.USERPROFILE || ".", relativePath);
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const obj = asObj(parsed);
  if (!obj) throw new Error(`${path} is not a JSON object`);
  return obj;
}

async function readPiAuth(path: string): Promise<AuthCredentials | undefined> {
  try {
    const json = await readJson(path);
    const entry = asObj(json["openai-codex"]);
    if (!entry) return undefined;
    const accessToken = str(entry.access);
    if (!accessToken) return undefined;
    const claims = extractClaims(accessToken);
    return {
      source: "pi",
      path,
      accessToken,
      refreshToken: str(entry.refresh),
      accountId: str(entry.accountId) ?? claims.accountId,
      expiresAtMs: num(entry.expires) ?? claims.expiresAtMs,
    };
  } catch {
    return undefined;
  }
}

async function readCodexAuth(path: string): Promise<AuthCredentials | undefined> {
  try {
    const json = await readJson(path);
    const tokens = asObj(json.tokens);
    if (!tokens) return undefined;
    const accessToken = str(tokens.access_token);
    if (!accessToken) return undefined;
    const claims = extractClaims(accessToken, str(tokens.id_token));
    return {
      source: "codex",
      path,
      accessToken,
      refreshToken: str(tokens.refresh_token),
      accountId: str(tokens.account_id) ?? claims.accountId,
      expiresAtMs: claims.expiresAtMs,
    };
  } catch {
    return undefined;
  }
}

async function refreshAuth(auth: AuthCredentials): Promise<AuthCredentials> {
  if (!auth.refreshToken) return auth;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: OPENAI_CODEX_CLIENT_ID,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) return auth;
  const json = asObj(await res.json());
  if (!json) return auth;
  const accessToken = str(json.access_token);
  if (!accessToken) return auth;
  const claims = extractClaims(accessToken, str(json.id_token));
  return {
    ...auth,
    accessToken,
    refreshToken: str(json.refresh_token) ?? auth.refreshToken,
    accountId: claims.accountId ?? auth.accountId,
    expiresAtMs: claims.expiresAtMs ?? auth.expiresAtMs,
  };
}

export async function resolveAuth(source: AuthSource = "auto"): Promise<AuthCredentials> {
  const piPath = homePath(".pi/agent/auth.json");
  const codexPath = homePath(".codex/auth.json");

  if (source === "pi") {
    const auth = await readPiAuth(piPath);
    if (!auth) throw new Error("No pi openai-codex auth found");
    return refreshAuth(auth);
  }
  if (source === "codex") {
    const auth = await readCodexAuth(codexPath);
    if (!auth) throw new Error("No codex cli auth found");
    return refreshAuth(auth);
  }

  const piAuth = await readPiAuth(piPath);
  if (piAuth) return refreshAuth(piAuth);
  const codexAuth = await readCodexAuth(codexPath);
  if (codexAuth) return refreshAuth(codexAuth);
  throw new Error("No usable Codex OAuth credentials found. Run pi /login first.");
}
