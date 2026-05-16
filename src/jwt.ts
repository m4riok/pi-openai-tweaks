function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwt(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export interface JwtClaims {
  email?: string;
  plan?: string;
  accountId?: string;
  expiresAtMs?: number;
}

export function extractClaims(accessToken?: string, idToken?: string): JwtClaims {
  const a = parseJwt(accessToken);
  const i = parseJwt(idToken);
  const merged = { ...(i ?? {}), ...(a ?? {}) };
  const exp = num(merged.exp);
  return {
    email: str(merged.email),
    plan: str(merged.plan_type) ?? str(merged.plan),
    accountId: str(merged.account_id) ?? str(merged.chatgpt_account_id),
    expiresAtMs: exp ? exp * 1000 : undefined,
  };
}
