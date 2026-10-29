import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";

const [build, role, argument] = process.argv.slice(2);
const config = await import(pathToFileURL(join(build, "src/config.js")));
const { SettingsManager } = await import("@earendil-works/pi-coding-agent");

process.send("ready");
await once(process, "message");
try {
  if (role === "hold") {
    const path = join(process.env.PI_CODING_AGENT_DIR, "settings.json");
    const release = lockfile.lockSync(path, { realpath: false });
    try {
      const settings = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, "");
      process.send("holding-empty-file");
      await once(process, "message");
      writeFileSync(path, JSON.stringify({ ...settings, theme: "core-updated" }));
    } finally {
      release();
    }
  } else if (role === "core") {
    const manager = SettingsManager.create(process.cwd(), process.env.PI_CODING_AGENT_DIR);
    manager.setTheme("core-updated");
    await manager.flush();
    const errors = manager.drainErrors();
    if (errors.length) throw errors[0].error;
  } else {
    await config[role](JSON.parse(argument));
  }
  process.disconnect();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  process.disconnect();
}
