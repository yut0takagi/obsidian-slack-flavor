// A throwaway Obsidian profile and vault with the plugin installed, and a way to start Obsidian on it.
// Nothing here reads or writes the developer's own profile or vaults, except copying the newest
// app package (obsidian-*.asar) so a local run uses the Obsidian version the developer actually runs.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "slack-flavor";
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];
const FIXTURE_VAULT = new URL("../../tests/smoke/vault/", import.meta.url);
const VAULT_ID = "5a0c0ffee5a0c0fe";

/** The Obsidian executable and, for local runs, the newest updated app package to test with. */
export function findObsidian() {
  const bin =
    process.env.OBSIDIAN_BIN ||
    (process.platform === "darwin" ? "/Applications/Obsidian.app/Contents/MacOS/Obsidian" : null);
  if (!bin || !existsSync(bin)) {
    throw new Error("Obsidian not found. Set OBSIDIAN_BIN to the Obsidian executable.");
  }
  return { bin, asar: process.env.OBSIDIAN_ASAR || newestAsar() };
}

function newestAsar() {
  const dir =
    process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/obsidian")
      : join(homedir(), ".config/obsidian");
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .map((f) => /^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$/.exec(f))
    .filter(Boolean)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  return versions.length ? join(dir, versions.at(-1)[0]) : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function createSandbox({ pluginDir }) {
  const { bin, asar } = findObsidian();
  const root = await mkdtemp(join(tmpdir(), "slack-flavor-smoke-"));
  const profile = join(root, "profile");
  const vault = join(root, "vault");
  const pluginTarget = join(vault, ".obsidian", "plugins", PLUGIN_ID);

  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, "obsidian.json"),
    JSON.stringify({ vaults: { [VAULT_ID]: { path: vault, ts: 0, open: true } }, updateDisabled: true }),
  );
  if (asar) await cp(asar, join(profile, asar.split("/").at(-1)));

  await cp(FIXTURE_VAULT, vault, { recursive: true });
  await mkdir(pluginTarget, { recursive: true });
  for (const f of PLUGIN_FILES) await cp(join(pluginDir, f), join(pluginTarget, f));

  const sandbox = {
    root,
    vault,
    bin,
    asar,

    async setEnabledPlugins(ids) {
      await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(ids));
    },

    async launch() {
      const port = await freePort();
      const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
      // The tar.gz build has no setuid sandbox helper, and containers have a tiny /dev/shm.
      if (process.platform === "linux") args.push("--no-sandbox", "--disable-dev-shm-usage");
      const log = createWriteStream(join(root, "obsidian.log"), { flags: "a" });
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      const exited = new Promise((resolve) => child.once("exit", resolve));
      return {
        port,
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          await exited;
          clearTimeout(timer);
        },
      };
    },

    async dispose() {
      if (process.env.SMOKE_KEEP === "1") {
        console.log(`  kept ${root}`);
        return;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
  await sandbox.setEnabledPlugins([]);
  return sandbox;
}
