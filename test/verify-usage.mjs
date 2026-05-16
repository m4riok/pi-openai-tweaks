#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const buildDir = mkdtempSync(join(tmpdir(), "pi-openai-tweaks-verify-"));

function print(title, value) {
  console.log(`\n## ${title}`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

try {
  execFileSync(
    "npx",
    ["tsc", "--outDir", buildDir, "--noEmit", "false", "--declaration", "false"],
    { stdio: "inherit" },
  );

  const usage = await import(pathToFileURL(join(buildDir, "usage.js")));
  const format = await import(pathToFileURL(join(buildDir, "format.js")));

  const baseSnapshot = (defaultLimit) => ({
    schemaVersion: 1,
    source: "api",
    fetchedAt: new Date().toISOString(),
    account: {},
    defaultLimit,
  });

  const display = (defaultLimit, percentMode = "remaining") => format.formatUsageStatusline(
    baseSnapshot(defaultLimit),
    undefined,
    { format: "compact", showWeekly: true, percentMode, updateMode: "turn" },
  );

  const fixtures = [
    {
      name: "normal order: 5h 9% used, 7d 69% used",
      raw: {
        primary_window: { used_percent: 9, limit_window_seconds: 18000, reset_after_seconds: 17455 },
        secondary_window: { used_percent: 69, limit_window_seconds: 604800, reset_after_seconds: 242601 },
      },
    },
    {
      name: "reversed order: weekly first, 5h second",
      raw: {
        primary_window: { used_percent: 69, limit_window_seconds: 604800, reset_after_seconds: 242601 },
        secondary_window: { used_percent: 9, limit_window_seconds: 18000, reset_after_seconds: 17455 },
      },
    },
    {
      name: "fresh reset: 5h 1% used, 7d 0% used",
      raw: {
        primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 18000 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800 },
      },
    },
    {
      name: "zero reset display: no 0h/0m units",
      raw: {
        primary_window: { used_percent: 95, limit_window_seconds: 18000, reset_after_seconds: 0 },
        secondary_window: { used_percent: 68, limit_window_seconds: 604800, reset_after_seconds: 86400 },
      },
    },
  ];

  for (const fixture of fixtures) {
    const parsed = usage.normalizeDefaultLimit(fixture.raw);
    print(`fixture: ${fixture.name}`, {
      parsed,
      compactRemaining: display(parsed, "remaining"),
      compactUsed: display(parsed, "used"),
    });
  }

  const live = await usage.getUsageSnapshot({ noCache: true });
  print("live normalized snapshot", live.defaultLimit);
  print("live compact remaining", format.formatUsageStatusline(
    live,
    undefined,
    { format: "compact", showWeekly: true, percentMode: "remaining", updateMode: "turn" },
  ));
  print("live compact used", format.formatUsageStatusline(
    live,
    undefined,
    { format: "compact", showWeekly: true, percentMode: "used", updateMode: "turn" },
  ));
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
