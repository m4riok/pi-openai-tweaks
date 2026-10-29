import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import lockfile from "proper-lockfile";

const root = fs.mkdtempSync(join(tmpdir(), "pi-settings-regression-"));
const build = join(root, "build");
const agentDir = join(root, "custom-agent");
const settingsPath = join(agentDir, "settings.json");
const workers = new Set();
// Set both before importing host code. Never inherit a real settings/auth/cache path.
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.CODEX_HOME = join(root, "codex");

function clean() {
  for (const child of workers) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
after(clean);
try {
  execFileSync("npx", ["tsc", "--outDir", build, "--noEmit", "false", "--declaration", "false"], { stdio: "inherit" });
  fs.symlinkSync(join(process.cwd(), "node_modules"), join(build, "node_modules"), "dir");
} catch (error) {
  clean();
  throw error;
}
const config = await import(pathToFileURL(join(build, "src/config.js")));
const { registerAutoCompact } = await import(pathToFileURL(join(build, "src/auto-compact.js")));
const { openSettingsMenu } = await import(pathToFileURL(join(build, "src/settings-menu.js")));
const { default: registerExtension } = await import(pathToFileURL(join(build, "index.js")));
const { initTheme, SettingsManager } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

function baseline() {
  return {
    packages: Array.from({ length: 19 }, (_, i) => `package-${i}`),
    extensions: ["-builtin:mcp"],
    defaultModel: "fixture-model",
    retry: { enabled: true },
    piOpenaiTweaks: {
      ...config.DEFAULT_USAGE_DISPLAY_CONFIG,
      autoCompact: { ...config.DEFAULT_AUTO_COMPACT_CONFIG, futureKey: "preserve" },
      futureKey: { nested: true },
    },
  };
}
function seed(value = baseline()) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(value));
}
function settings() {
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}
function assertClean() {
  assert.equal(fs.existsSync(`${settingsPath}.lock`), false);
  assert.deepEqual(fs.readdirSync(agentDir).filter(name => name.endsWith(".tmp")), []);
}
async function withFsFault(method, replacement, action) {
  const original = fs[method];
  fs[method] = (...args) => replacement(original, ...args);
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    fs[method] = original;
    syncBuiltinESMExports();
  }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function startWorker(role, patch) {
  const child = fork(new URL("./fixtures/settings-worker.mjs", import.meta.url), [build, role, JSON.stringify(patch)], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  workers.add(child);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit").then(([code]) => {
    workers.delete(child);
    return { code, stderr };
  });
  assert.equal((await once(child, "message"))[0], "ready");
  return {
    child,
    async finish() {
      const result = await exited;
      assert.equal(result.code, 0, result.stderr);
    },
  };
}
function commandHarness(register) {
  const commands = new Map();
  const listeners = new Map();
  register({
    registerCommand: (name, options) => commands.set(name, options),
    on: (event, handler) => listeners.set(event, [...listeners.get(event) ?? [], handler]),
  });
  const notifications = [];
  const ctx = {
    hasUI: false,
    cwd: root,
    getContextUsage: () => undefined,
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
  return { commands, listeners, notifications, ctx };
}
function menuContext() {
  const opened = deferred();
  const notifications = [];
  const ctx = {
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      custom: factory => new Promise(done => {
        const component = factory({ requestRender() {} }, undefined, undefined, done);
        opened.resolve(component);
      }),
    },
  };
  return { opened, notifications, ctx };
}

beforeEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  seed();
});

test("missing settings use defaults and first save creates private file in configured agent directory", async () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  assert.deepEqual(await config.loadDisplayConfig(), config.DEFAULT_USAGE_DISPLAY_CONFIG);
  assert.deepEqual(await config.loadAutoCompactConfig(), config.DEFAULT_AUTO_COMPACT_CONFIG);
  await config.saveAutoCompactConfig({ enabled: true });
  assert.deepEqual(settings(), { piOpenaiTweaks: { autoCompact: { enabled: true } } });
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(join(process.env.HOME, ".pi/agent/settings.json")), false);
  assertClean();
});

for (const text of ["", '{"packages":[', "null", "[]", '"string"', "12"]) {
  test(`reject malformed/non-object settings without overwriting bytes: ${JSON.stringify(text)}`, async () => {
    fs.writeFileSync(settingsPath, text);
    for (const operation of [
      () => config.loadDisplayConfig(),
      () => config.loadAutoCompactConfig(),
      () => config.saveDisplayConfig({ show5h: true }),
      () => config.saveAutoCompactConfig({ enabled: true, thresholdPercent: 95 }),
    ]) {
      await assert.rejects(operation, error => error.message.includes(settingsPath));
      assert.equal(fs.readFileSync(settingsPath, "utf8"), text);
      assertClean();
    }
  });
}

for (const namespace of [{ piOpenaiTweaks: null }, { piOpenaiTweaks: [] }, { piOpenaiTweaks: { autoCompact: false } }]) {
  test(`reject malformed extension section without replacing it: ${JSON.stringify(namespace)}`, async () => {
    seed({ ...baseline(), ...namespace });
    const before = fs.readFileSync(settingsPath, "utf8");
    await assert.rejects(config.saveAutoCompactConfig({ enabled: true }), /must contain a JSON object/);
    await assert.rejects(config.loadAutoCompactConfig(), /must contain a JSON object/);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
    assertClean();
  });
}

test("BOM input retains unrelated settings; leaf patches preserve sections, sibling fields and unknown keys", async () => {
  fs.writeFileSync(settingsPath, `\uFEFF${JSON.stringify(baseline())}`);
  const loaded = await config.loadDisplayConfig();
  assert.deepEqual(loaded, config.DEFAULT_USAGE_DISPLAY_CONFIG);
  const display = await config.saveDisplayConfig({ show5h: true });
  const compact = await config.saveAutoCompactConfig({ thresholdPercent: 95 });
  await config.saveAutoCompactConfig({ enabled: true });
  await config.saveDisplayConfig({ format: "compact" });
  assert.equal(display.show5h, true);
  assert.equal(compact.enabled, false);
  const expected = baseline();
  Object.assign(expected.piOpenaiTweaks, { show5h: true, format: "compact" });
  Object.assign(expected.piOpenaiTweaks.autoCompact, { enabled: true, thresholdPercent: 95 });
  assert.deepEqual(settings(), expected);
  assertClean();
});

for (const code of ["EACCES", "EIO"]) {
  test(`read ${code} rejects, retains original settings and releases lock`, async () => {
    const before = fs.readFileSync(settingsPath, "utf8");
    await withFsFault("readFileSync", (original, path, ...args) => {
      if (path === settingsPath) throw Object.assign(new Error(`injected ${code}`), { code });
      return original(path, ...args);
    }, async () => {
      await assert.rejects(config.loadDisplayConfig(), new RegExp(code));
      await assert.rejects(config.saveAutoCompactConfig({ enabled: true }), error => error.cause.code === code);
    });
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
    assertClean();
    await config.saveAutoCompactConfig({ enabled: true });
  });
}

for (const method of ["writeFileSync", "renameSync"]) {
  test(`${method} failure leaves original valid file unchanged, removes temporary and releases lock`, async () => {
    const before = fs.readFileSync(settingsPath, "utf8");
    await withFsFault(method, (original, ...args) => {
      if (method === "writeFileSync") original(args[0], '{"partial":');
      throw Object.assign(new Error(`injected ${method} failure`), { code: "EIO" });
    }, () => assert.rejects(config.saveDisplayConfig({ show5h: true }), /injected/));
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
    assertClean();
    await config.saveDisplayConfig({ show5h: true });
    assert.equal(settings().piOpenaiTweaks.show5h, true);
  });
}

test("replacement publishes complete JSON only at rename and preserves permissions", async () => {
  fs.chmodSync(settingsPath, 0o640);
  const before = fs.readFileSync(settingsPath, "utf8");
  let replacements = 0;
  await withFsFault("renameSync", (original, source, destination) => {
    assert.equal(destination, settingsPath);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
    assert.equal(JSON.parse(fs.readFileSync(source, "utf8")).piOpenaiTweaks.show5h, true);
    replacements++;
    return original(source, destination);
  }, () => config.saveDisplayConfig({ show5h: true }));
  assert.equal(replacements, 1);
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o640);
  assertClean();
});

test("existing settings symlink remains intact while target is updated", async () => {
  const target = join(root, "linked-settings.json");
  fs.renameSync(settingsPath, target);
  fs.symlinkSync(target, settingsPath);
  await config.saveDisplayConfig({ show5h: true });
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
  assert.equal(settings().piOpenaiTweaks.show5h, true);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).packages.length, 19);
  assertClean();
});

test("dangling settings symlink is not replaced with defaults", async () => {
  fs.rmSync(settingsPath);
  fs.symlinkSync(join(root, "missing-target.json"), settingsPath);
  await assert.rejects(config.saveAutoCompactConfig({ enabled: true }), /ENOENT/);
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
  assertClean();
});

test("held core-compatible lock fails visibly without modifying file", async () => {
  const before = fs.readFileSync(settingsPath, "utf8");
  const release = lockfile.lockSync(settingsPath, { realpath: false });
  try {
    await assert.rejects(config.saveAutoCompactConfig({ enabled: true }), error => error.cause.code === "ELOCKED");
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
    assert.equal(fs.existsSync(`${settingsPath}.lock`), true);
  } finally {
    release();
  }
  await config.saveAutoCompactConfig({ enabled: true });
  assertClean();
});

test("read and save wait out separate process's locked empty window and merge its latest write", async () => {
  const holder = await startWorker("hold");
  const holding = once(holder.child, "message");
  holder.child.send("go");
  assert.equal((await holding)[0], "holding-empty-file");
  const original = lockfile.lockSync;
  const observed = deferred();
  lockfile.lockSync = (...args) => {
    try { return original(...args); }
    catch (error) { if (error.code === "ELOCKED") observed.resolve(); throw error; }
  };
  try {
    const reading = config.loadDisplayConfig();
    const saving = config.saveAutoCompactConfig({ enabled: true, thresholdPercent: 95 });
    await observed.promise;
    assert.equal(fs.readFileSync(settingsPath, "utf8"), "");
    holder.child.send("release");
    await Promise.all([reading, saving, holder.finish()]);
  } finally {
    lockfile.lockSync = original;
  }
  assert.equal(settings().theme, "core-updated");
  assert.equal(settings().packages.length, 19);
  assert.deepEqual(await config.loadAutoCompactConfig(), { enabled: true, thresholdPercent: 95 });
  assertClean();
});

test("independent extension processes and real core writer preserve all concurrent edits", async () => {
  const children = await Promise.all([
    startWorker("saveDisplayConfig", { format: "compact" }),
    startWorker("saveDisplayConfig", { show5h: true }),
    startWorker("saveAutoCompactConfig", { enabled: true }),
    startWorker("saveAutoCompactConfig", { thresholdPercent: 95 }),
    startWorker("core"),
  ]);
  for (const worker of children) worker.child.send("go");
  await Promise.all(children.map(worker => worker.finish()));
  const expected = baseline();
  expected.theme = "core-updated";
  Object.assign(expected.piOpenaiTweaks, { format: "compact", show5h: true });
  Object.assign(expected.piOpenaiTweaks.autoCompact, { enabled: true, thresholdPercent: 95 });
  assert.deepEqual(settings(), expected);
  assertClean();
});

test("host writer on same event loop cannot interrupt extension's locked transaction", async () => {
  const manager = SettingsManager.create(root, agentDir);
  const save = config.saveAutoCompactConfig({ enabled: true });
  manager.setTheme("same-process-core");
  await Promise.all([save, manager.flush()]);
  assert.deepEqual(manager.drainErrors(), []);
  assert.equal(settings().theme, "same-process-core");
  assert.equal(settings().piOpenaiTweaks.autoCompact.enabled, true);
  assertClean();
});

test("stale auto-compact command sessions patch only intended field; failed save leaves live state unchanged", async () => {
  const first = commandHarness(registerAutoCompact);
  const second = commandHarness(registerAutoCompact);
  for (const harness of [first, second]) await harness.listeners.get("session_start")[0]({}, harness.ctx);
  await first.commands.get("autocompact").handler("on", first.ctx);
  await second.commands.get("autocompact").handler("threshold 95", second.ctx);
  assert.deepEqual(await config.loadAutoCompactConfig(), { enabled: true, thresholdPercent: 95 });
  fs.writeFileSync(settingsPath, "{");
  await second.commands.get("autocompact").handler("off", second.ctx);
  assert.equal(second.notifications.at(-1).level, "error");
  await second.commands.get("autocompact").handler("status", second.ctx);
  assert.match(second.notifications.at(-1).message, /on, trigger 95%/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "{");
});

test("usage commands patch only requested preference across stale sessions", async () => {
  const first = commandHarness(registerExtension);
  const second = commandHarness(registerExtension);
  // No credentials in fixture HOME: usage refresh errors are contained, not network requests.
  await first.commands.get("usage").handler("format compact", first.ctx);
  await second.commands.get("usage").handler("5h on", second.ctx);
  assert.equal(settings().piOpenaiTweaks.format, "compact");
  assert.equal(settings().piOpenaiTweaks.show5h, true);
  fs.writeFileSync(settingsPath, "{");
  await first.commands.get("usage").handler("weekly off", first.ctx);
  assert.equal(first.notifications.at(-1).level, "error");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "{");
  let rendered;
  first.ctx.ui.custom = async factory => {
    const component = factory({ requestRender() {} }, undefined, undefined, () => {});
    rendered = stripVTControlCharacters(component.render(80).join("\n"));
  };
  await first.commands.get("usage").handler("", first.ctx);
  assert.match(rendered, /Show weekly\s+on/);
});

test("startup reports settings read errors without resetting file", async () => {
  const harness = commandHarness(registerExtension);
  fs.writeFileSync(settingsPath, "{");
  for (const listener of harness.listeners.get("session_start")) await listener({}, harness.ctx);
  assert.equal(harness.notifications.length, 2);
  assert.ok(harness.notifications.every(item => item.level === "error" && item.message.includes(settingsPath)));
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "{");
});

test("usage menu keeps saved value when subsequent usage refresh fails", async () => {
  const harness = commandHarness(registerExtension);
  const menu = menuContext();
  harness.ctx.ui.custom = menu.ctx.ui.custom;
  const command = harness.commands.get("usage").handler("", harness.ctx);
  const component = await menu.opened.promise;
  component.handleInput("\r");
  component.handleInput("\x1b");
  await command;
  assert.equal(settings().piOpenaiTweaks.format, "compact");
  assert.match(component.render(80).join("\n"), /compact/);
  assert.ok(harness.notifications.some(item => item.level === "error" && item.message.startsWith("Usage unavailable:")));
  assert.ok(harness.notifications.every(item => !item.message.startsWith("Settings change failed:")));
});

test("menu catches rejected callbacks, rolls back displayed value and survives later edits", async () => {
  const harness = menuContext();
  const items = [{ id: "enabled", label: "Enabled", currentValue: "off", values: ["off", "on"] }];
  let calls = 0;
  const menu = openSettingsMenu(harness.ctx, items, async () => {
    if (++calls === 1) throw new Error("injected save failure");
  });
  const component = await harness.opened.promise;
  component.handleInput("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(items[0].currentValue, "off");
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /injected save failure/);
  component.handleInput("\r");
  component.handleInput("\x1b");
  await menu;
  assert.equal(calls, 2);
  assert.equal(items[0].currentValue, "on");
});

test("menu serializes rapid edits without replacing newer selections and awaits saves after close", async () => {
  const harness = menuContext();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const values = [];
  const items = [{ id: "enabled", label: "Enabled", currentValue: "off", values: ["off", "on"] }];
  const menu = openSettingsMenu(harness.ctx, items, async (_id, value) => {
    values.push(value);
    if (values.length === 1) { firstStarted.resolve(); await releaseFirst.promise; }
    if (values.length === 2) { secondStarted.resolve(); await releaseSecond.promise; }
  });
  const component = await harness.opened.promise;
  component.handleInput("\r");
  component.handleInput("\r");
  await firstStarted.promise;
  assert.deepEqual(values, ["on"]);
  releaseFirst.resolve();
  await secondStarted.promise;
  assert.equal(items[0].currentValue, "off");
  component.handleInput("\r");
  component.handleInput("\x1b");
  let finished = false;
  menu.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseSecond.resolve();
  await menu;
  assert.deepEqual(values, ["on", "off", "on"]);
  assert.equal(items[0].currentValue, "on");
});
