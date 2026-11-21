// npm run smoke: start a real Obsidian on a throwaway profile and vault, drive the plugin through the
// things a user does first, and fail if a step hangs or the plugin logs an error. Never talks to Slack.
//
//   OBSIDIAN_BIN      Obsidian executable (default: /Applications/Obsidian.app on macOS)
//   OBSIDIAN_ASAR     app package to run (default: the newest one in your Obsidian profile, if any)
//   SMOKE_PLUGIN_DIR  folder with main.js, manifest.json, styles.css (default: the repo root)
//   SMOKE_KEEP=1      keep the temp profile and vault for a look afterwards
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";
import { createSandbox, PLUGIN_ID } from "./sandbox.mjs";

const LAUNCH_MS = 90_000;
const STEP_MS = 20_000;
const pluginDir = process.env.SMOKE_PLUGIN_DIR || fileURLToPath(new URL("../../", import.meta.url));

// Page-side helpers, prepended to every expression.
const PRELUDE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plugin = () => app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
  const leafIn = (mode) => app.workspace.getLeavesOfType("markdown").find((l) => l.view.getMode() === mode);
  const closeModals = () => document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click());
  async function until(check, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const v = check();
      if (v) return v;
    }
    return check();
  }
`;
const page = (body) => `(async () => { ${PRELUDE} ${body} })()`;

class StepFailure extends Error {}
function expect(ok, message) {
  if (!ok) throw new StepFailure(message);
}

const BOOT = page(`
  await until(() => window.app?.workspace?.layoutReady, ${LAUNCH_MS});
  const atStartup = !!plugin();
  await app.plugins.setEnable(true);
  closeModals();
  const version = window.require?.("electron")?.ipcRenderer.sendSync("version") ?? document.title;
  return { version, atStartup };
`);

/** The steps of one run, in order. Each gets the live connection of the current Obsidian session. */
const steps = [
  {
    name: "open the fixture note in live preview and reading view",
    async run({ cdp }) {
      const modes = await cdp.evaluate(
        page(`
          const file = await until(() => app.vault.getFileByPath("Emoji.md"), 10000);
          await app.workspace.getLeaf(false).openFile(file, { state: { mode: "source", source: false } });
          await app.workspace.getLeaf("split", "vertical").openFile(file, { state: { mode: "preview" } });
          app.workspace.setActiveLeaf(leafIn("source"), { focus: true });
          return app.workspace.getLeavesOfType("markdown").map((l) => l.view.getMode()).sort();
        `),
        STEP_MS,
      );
      expect(JSON.stringify(modes) === '["preview","source"]', `open leaves: ${JSON.stringify(modes)}`);
    },
  },
  {
    name: "enable the plugin",
    async run({ cdp }) {
      const r = await cdp.evaluate(page(`return { ok: await app.plugins.enablePluginAndSave(${JSON.stringify(PLUGIN_ID)}), loaded: !!plugin() };`), STEP_MS);
      expect(r.ok && r.loaded, `enablePluginAndSave returned ${r.ok}, loaded: ${r.loaded}`);
    },
  },
  {
    name: "render emoji and the slack block",
    async run({ cdp }) {
      const r = await cdp.evaluate(
        page(`
          const count = () => ({
            blocks: leafIn("preview").view.previewMode.containerEl.querySelectorAll(".sf-block").length,
            readingEmoji: leafIn("preview").view.previewMode.containerEl.querySelectorAll(".sf-emoji").length,
            livePreviewEmoji: leafIn("source").view.editor.cm.contentDOM.querySelectorAll(".sf-emoji").length,
          });
          await until(() => { const c = count(); return c.blocks && c.readingEmoji && c.livePreviewEmoji; }, 5000);
          return count();
        `),
        STEP_MS,
      );
      expect(r.blocks > 0 && r.readingEmoji > 0 && r.livePreviewEmoji > 0, `rendered: ${JSON.stringify(r)}`);
    },
  },
  {
    name: "open the plugin's settings",
    async run({ cdp }) {
      // The 500 ms timer is a macrotask: it never fires while a promise loop (like #4) spins.
      const items = await cdp.evaluate(
        page(`
          app.setting.open();
          app.setting.openTabById(${JSON.stringify(PLUGIN_ID)});
          await sleep(500);
          const tab = app.setting.activeTab;
          return tab?.id === ${JSON.stringify(PLUGIN_ID)} ? tab.containerEl.querySelectorAll(".setting-item").length : -1;
        `),
        STEP_MS,
      );
      expect(items >= 5, `settings items: ${items}`);
    },
  },
  {
    name: "add a workspace",
    async run({ cdp }) {
      const r = await cdp.evaluate(
        page(`
          const el = app.setting.activeTab.containerEl;
          const button = [...el.querySelectorAll("button")].find((b) => b.textContent === plugin().strings.settingsAdd);
          if (!button) return { error: "no Add workspace button" };
          button.click();
          await sleep(500);
          const result = { workspaces: plugin().settings.workspaces.length, rows: el.querySelectorAll(".sf-workspace-setting").length };
          app.setting.close();
          return result;
        `),
        STEP_MS,
      );
      expect(!r.error && r.workspaces === 1 && r.rows === 1, JSON.stringify(r));
    },
  },
  {
    name: "copy the note as Slack text (without touching the system clipboard)",
    async run({ cdp }) {
      // The plugin writes through a copy event. Answer execCommand("copy") with a synthetic event whose
      // DataTransfer we keep, so the run never replaces what the developer has on their clipboard.
      const r = await cdp.evaluate(
        page(`
          app.workspace.setActiveLeaf(leafIn("source"), { focus: true });
          const original = document.execCommand;
          const captured = new DataTransfer();
          document.execCommand = (command, ...rest) => {
            if (command !== "copy") return original.call(document, command, ...rest);
            window.dispatchEvent(new ClipboardEvent("copy", { clipboardData: captured, cancelable: true }));
            return true;
          };
          try {
            const ran = app.commands.executeCommandById(${JSON.stringify(PLUGIN_ID)} + ":copy-as-slack");
            await sleep(200);
            return { ran, types: [...captured.types].sort(), plain: captured.getData("text/plain") };
          } finally {
            document.execCommand = original;
          }
        `),
        STEP_MS,
      );
      expect(r.ran, "the command did not run");
      expect(JSON.stringify(r.types) === '["slack/texty","text/html","text/plain"]', `clipboard types: ${JSON.stringify(r.types)}`);
      expect(r.plain.includes(":tada:") && r.plain.includes("*Emoji*"), `plain text: ${JSON.stringify(r.plain.slice(0, 120))}`);
    },
  },
  {
    name: "run the other commands",
    async run({ cdp }) {
      const r = await cdp.evaluate(
        page(`
          app.workspace.setActiveLeaf(leafIn("source"), { focus: true });
          const ran = {};
          for (const id of ["refresh-emoji", "switch-workspace", "import-thread"]) {
            ran[id] = app.commands.executeCommandById(${JSON.stringify(PLUGIN_ID)} + ":" + id);
            await sleep(200);
            closeModals();
          }
          return ran;
        `),
        STEP_MS,
      );
      const failed = Object.entries(r).filter(([, ok]) => ok !== true);
      expect(!failed.length, `commands that did not run: ${failed.map(([id]) => id).join(", ")}`);
    },
  },
  {
    name: "restart Obsidian with the plugin enabled",
    async run(session) {
      await session.restart([PLUGIN_ID]);
      // Past the 5 s startup refresh of emoji lists.
      const r = await session.cdp.evaluate(page(`await sleep(6000); return { loaded: !!plugin(), workspaces: plugin()?.settings.workspaces.length ?? 0 };`), STEP_MS);
      expect(r.loaded && r.workspaces === 1, `after restart: ${JSON.stringify(r)}`);
    },
  },
  {
    name: "disable the plugin",
    async run({ cdp }) {
      const gone = await cdp.evaluate(page(`await app.plugins.disablePluginAndSave(${JSON.stringify(PLUGIN_ID)}); return !plugin();`), STEP_MS);
      expect(gone, "the plugin is still loaded");
    },
  },
];

async function main() {
  const sandbox = await createSandbox({ pluginDir });
  console.log(`Obsidian: ${sandbox.bin}${sandbox.asar ? `\n  app package: ${sandbox.asar}` : ""}\nPlugin: ${pluginDir}`);

  const errors = [];
  let obsidian = null;
  const session = {
    cdp: null,
    async start() {
      obsidian = await sandbox.launch();
      this.cdp = await connect(obsidian.port, LAUNCH_MS);
      const boot = await this.cdp.evaluate(BOOT, LAUNCH_MS);
      return boot;
    },
    async stop() {
      if (this.cdp) {
        errors.push(...this.cdp.pluginErrors);
        this.cdp.close();
        this.cdp = null;
      }
      await obsidian?.stop();
      obsidian = null;
    },
    async restart(enabled) {
      await this.stop();
      await sandbox.setEnabledPlugins(enabled);
      const boot = await this.start();
      console.log(`    loaded at startup: ${boot.atStartup ? "yes" : "no (community plugins were off)"}`);
    },
  };

  let failed = false;
  try {
    const { version } = await session.start();
    console.log(`Running Obsidian ${version}\n`);
    for (const step of steps) {
      const started = Date.now();
      try {
        await step.run(session);
        console.log(`  ✓ ${step.name} (${Date.now() - started} ms)`);
      } catch (err) {
        console.log(`  ✗ ${step.name}: ${err.message}`);
        failed = true;
        break;
      }
    }
  } catch (err) {
    console.log(`  ✗ start Obsidian: ${err.message}`);
    failed = true;
  } finally {
    await session.stop();
  }

  if (errors.length) {
    failed = true;
    console.log(`\n  ✗ the plugin logged ${errors.length} error(s):`);
    for (const e of errors) console.log(`    ${e.split("\n").join("\n    ")}`);
  }
  if (failed) {
    const log = await readFile(join(sandbox.root, "obsidian.log"), "utf8").catch(() => "");
    if (log.trim()) console.log(`\nLast lines of Obsidian's output:\n${log.trim().split("\n").slice(-30).join("\n")}`);
  }
  await sandbox.dispose();
  console.log(failed ? "\nSmoke test FAILED" : "\nSmoke test passed");
  process.exitCode = failed ? 1 : 0;
}

await main();
