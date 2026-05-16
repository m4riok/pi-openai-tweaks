import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodexUsageSnapshot } from "./types.js";

export function defaultCacheFile(): string {
  const base = process.env.XDG_CACHE_HOME || join(process.env.HOME || process.env.USERPROFILE || ".", ".cache");
  return join(base, "pi-openai-tweaks", "usage.json");
}

export async function readCachedSnapshot(path = defaultCacheFile()): Promise<CodexUsageSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as CodexUsageSnapshot;
  } catch {
    return undefined;
  }
}

export async function writeCachedSnapshot(snapshot: CodexUsageSnapshot, path = defaultCacheFile()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

export function cacheAgeMs(snapshot?: CodexUsageSnapshot): number {
  if (!snapshot) return Number.POSITIVE_INFINITY;
  const ts = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(ts) ? Date.now() - ts : Number.POSITIVE_INFINITY;
}

export function isFresh(snapshot: CodexUsageSnapshot | undefined, maxAgeMs: number): boolean {
  return cacheAgeMs(snapshot) <= maxAgeMs;
}
