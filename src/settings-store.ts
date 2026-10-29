import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 20;

type Settings = Record<string, unknown>;

export function isObject(value: unknown): value is Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function readSettingsFile(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      try {
        lstatSync(path);
      } catch (statError) {
        if (hasCode(statError, "ENOENT")) return {};
        throw statError;
      }
      // A dangling symlink exists, but its target is unavailable. Do not reset it.
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isObject(parsed)) throw new Error("Settings must contain a JSON object");
  return parsed;
}

function writeSettingsFile(path: string, settings: Settings): void {
  let mode = 0o600;
  let target = path;
  try {
    mode = statSync(path).mode & 0o777;
    // Preserve an existing settings symlink; replace its target, not the link.
    target = realpathSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", mode);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Settings replacement and temporary-file cleanup failed (${temporary})`);
    }
    throw error;
  }
}

async function withSettings<T>(action: (settings: Settings, path: string) => T): Promise<T> {
  const path = join(getAgentDir(), "settings.json");
  try {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 1; ; attempt++) {
      let release: () => void;
      try {
        // Same lock path and stale defaults as Pi's FileSettingsStorage.
        release = lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        if (!hasCode(error, "ELOCKED") || attempt === LOCK_ATTEMPTS) throw error;
        await delay(LOCK_RETRY_MS);
        continue;
      }
      // No await while holding the lock: Pi's synchronous writer can run on
      // this same event loop and must never wait for an async operation we own.
      try {
        return action(readSettingsFile(path), path);
      } finally {
        release();
      }
    }
  } catch (error) {
    throw new Error(`Settings unavailable (${path}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function readSettings(): Promise<Settings> {
  return withSettings((settings) => settings);
}

export async function updateSettings<T>(update: (settings: Settings) => T): Promise<T> {
  return withSettings((settings, path) => {
    const result = update(settings);
    writeSettingsFile(path, settings);
    return result;
  });
}
