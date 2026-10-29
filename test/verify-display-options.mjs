#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const buildDir = mkdtempSync(join(tmpdir(), "pi-openai-tweaks-display-build-"));
const homeDir = mkdtempSync(join(tmpdir(), "pi-openai-tweaks-display-home-"));

try {
  execFileSync(
    "npx",
    ["tsc", "--outDir", buildDir, "--noEmit", "false", "--declaration", "false"],
    { stdio: "inherit" },
  );

  process.env.HOME = homeDir;
  process.env.PI_CODING_AGENT_DIR = join(homeDir, ".pi", "agent");
  symlinkSync(join(process.cwd(), "node_modules"), join(buildDir, "node_modules"), "dir");
  const configModule = await import(pathToFileURL(join(buildDir, "src", "config.js")));
  const { formatUsageStatusline } = await import(pathToFileURL(join(buildDir, "src", "format.js")));
  const { AUTO_COMPACT_PERCENT_VALUES, registerAutoCompact } = await import(
    pathToFileURL(join(buildDir, "src", "auto-compact.js")),
  );
  assert.equal(AUTO_COMPACT_PERCENT_VALUES.length, 50);
  assert.equal(AUTO_COMPACT_PERCENT_VALUES[0], 50);
  assert.equal(AUTO_COMPACT_PERCENT_VALUES.at(-1), 99);

  const defaultConfig = await configModule.loadDisplayConfig();
  assert.equal(defaultConfig.show5h, false);
  assert.equal(defaultConfig.showWeekly, true);

  const snapshot = {
    schemaVersion: 1,
    source: "api",
    fetchedAt: new Date().toISOString(),
    account: {},
    defaultLimit: {
      id: "codex",
      name: "Codex",
      primary: { usedPercent: 10, leftPercent: 90, resetAfterSeconds: 3600 },
      secondary: { usedPercent: 20, leftPercent: 80, resetAfterSeconds: 86400 },
    },
  };

  const defaultLine = formatUsageStatusline(snapshot, undefined, defaultConfig);
  assert.doesNotMatch(defaultLine, /5h:/);
  assert.match(defaultLine, /7d:/);

  const bothLine = formatUsageStatusline(snapshot, undefined, { ...defaultConfig, show5h: true });
  assert.match(bothLine, /5h:/);
  assert.match(bothLine, /7d:/);

  const fiveHourLine = formatUsageStatusline(snapshot, undefined, {
    ...defaultConfig,
    show5h: true,
    showWeekly: false,
  });
  assert.match(fiveHourLine, /5h:/);
  assert.doesNotMatch(fiveHourLine, /7d:/);

  const defaultAutoCompact = await configModule.loadAutoCompactConfig();
  assert.deepEqual(defaultAutoCompact, { enabled: false, thresholdPercent: 90 });

  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  await configModule.saveAutoCompactConfig({ enabled: true, thresholdPercent: 91 });
  await configModule.saveDisplayConfig({ ...defaultConfig, show5h: true });
  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.piOpenaiTweaks.show5h, true);
  assert.deepEqual(settings.piOpenaiTweaks.autoCompact, { enabled: true, thresholdPercent: 91 });
  assert.equal((await configModule.loadDisplayConfig()).show5h, true);
  assert.deepEqual(await configModule.loadAutoCompactConfig(), { enabled: true, thresholdPercent: 91 });

  const commands = new Map();
  const listeners = new Map();
  const sentMessages = [];
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      listeners.set(event, handler);
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };
  registerAutoCompact(pi);

  let usage = { tokens: 247_520, contextWindow: 272_000, percent: 91 };
  let compactOptions;
  const notifications = [];
  const ctx = {
    hasUI: false,
    model: { contextWindow: 272_000 },
    getContextUsage: () => usage,
    compact: (options) => {
      compactOptions = options;
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
  };

  await listeners.get("session_start")({}, ctx);
  const command = commands.get("autocompact");
  await command.handler("threshold 92", ctx);
  assert.deepEqual(await configModule.loadAutoCompactConfig(), { enabled: true, thresholdPercent: 92 });
  assert.match(notifications.at(-1).message, /92% of 272K \(250\.2K\)/);

  await command.handler("threshold 100", ctx);
  assert.equal(notifications.at(-1).level, "error");
  assert.deepEqual(await configModule.loadAutoCompactConfig(), { enabled: true, thresholdPercent: 92 });

  listeners.get("turn_end")({ message: {}, toolResults: [{}] }, ctx);
  assert.equal(compactOptions, undefined);

  usage = { tokens: 250_240, contextWindow: 272_000, percent: 92 };
  listeners.get("turn_end")({ message: {}, toolResults: [{}] }, ctx);
  assert.ok(compactOptions);
  compactOptions.onComplete();
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].options.triggerTurn, true);
  assert.equal(sentMessages[0].message.display, false);

  compactOptions = undefined;
  listeners.get("turn_end")({ message: {}, toolResults: [] }, ctx);
  assert.ok(compactOptions);
  compactOptions.onComplete();
  assert.equal(sentMessages.length, 1);

  await command.handler("off", ctx);
  compactOptions = undefined;
  listeners.get("turn_end")({ message: {}, toolResults: [{}] }, ctx);
  assert.equal(compactOptions, undefined);

  console.log("display and auto-compact verification passed");
} finally {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
}
