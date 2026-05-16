#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const buildDir = mkdtempSync(join(tmpdir(), "pi-openai-tweaks-zeroes-"));

const snapshot = (primarySeconds, secondarySeconds) => ({
  schemaVersion: 1,
  source: "api",
  fetchedAt: new Date().toISOString(),
  account: {},
  defaultLimit: {
    id: "codex",
    name: "Codex",
    primary: { usedPercent: 10, leftPercent: 90, resetAfterSeconds: primarySeconds },
    secondary: { usedPercent: 20, leftPercent: 80, resetAfterSeconds: secondarySeconds },
  },
});

try {
  execFileSync(
    "npx",
    ["tsc", "--outDir", buildDir, "--noEmit", "false", "--declaration", "false"],
    { stdio: "inherit" },
  );

  const { formatUsageStatusline } = await import(pathToFileURL(join(buildDir, "format.js")));
  const config = { format: "compact", showWeekly: true, percentMode: "remaining", updateMode: "turn" };

  const cases = [
    { name: "5h0m + 7d0h", primary: 5 * 3600, secondary: 7 * 24 * 3600 },
    { name: "0h2m + 0d2h", primary: 2 * 60, secondary: 2 * 3600 },
    { name: "0h0m + 0d0h", primary: 0, secondary: 0 },
    { name: "1h0m + 1d0h", primary: 3600, secondary: 24 * 3600 },
    { name: "1h1m + 1d1h", primary: 3660, secondary: 25 * 3600 },
  ];

  for (const c of cases) {
    console.log(`\n${c.name}`);
    console.log(formatUsageStatusline(snapshot(c.primary, c.secondary), undefined, config));
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
