// npm run smoke: start a real Obsidian on a throwaway profile and vault, drive the plugin through the
// things a user does first, and fail if a step hangs or the plugin logs an error. It runs twice: as the
// desktop app, then with Obsidian emulating a phone (its own mobile UI on a phone-sized window).
// Never talks to Slack and never touches your vaults, profile or clipboard.
//
//   OBSIDIAN_BIN       Obsidian executable (default: /Applications/Obsidian.app on macOS)
//   OBSIDIAN_ASAR      app package to run (default: the newest one in your Obsidian profile, if any)
//   SMOKE_PLUGIN_DIR   folder with main.js, manifest.json, styles.css (default: the repo root)
//   SMOKE_PASSES       desktop,mobile (default) or just one of them
//   SMOKE_SCREENSHOTS  folder to save screenshots of each pass into
//   SMOKE_KEEP=1       keep the temp profile and vault for a look afterwards
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";
import { createSandbox, PLUGIN_ID } from "./sandbox.mjs";

const LAUNCH_MS = 90_000;
const STEP_MS = 20_000;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
// A 48×32 PNG, the same bytes as tests/smoke/vault/slack-F0SMOKE1.png.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAN0lEQVR4nO3OQQ0AMAgEMExgivn3MxccjyYV0Jp+p1R8ICQkJJQeCAkJCaUHQkJCQumBkJDQsg/p0/wumd6ArgAAAABJRU5ErkJggg==";
const pluginDir = process.env.SMOKE_PLUGIN_DIR || fileURLToPath(new URL("../../", import.meta.url));
const passes = (process.env.SMOKE_PASSES || "desktop,mobile").split(",").map((p) => p.trim());
const screenshotDir = process.env.SMOKE_SCREENSHOTS || null;

// Page-side helpers, prepended to every expression.
const PRELUDE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plugin = () => app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
  const noteLeaf = () => app.workspace.getLeavesOfType("markdown")[0];
  async function until(check, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const v = check();
      if (v) return v;
    }
    return check();
  }
  async function setMode(mode) {
    const leaf = noteLeaf();
    const vs = leaf.getViewState();
    await leaf.setViewState({ ...vs, state: { ...vs.state, mode, source: false } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }
`;
const page = (body) => `(async () => { ${PRELUDE} ${body} })()`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StepFailure extends Error {}
function expect(ok, message) {
  if (!ok) throw new StepFailure(message);
}

const BOOT = page(`
  await until(() => window.app?.workspace?.layoutReady, ${LAUNCH_MS});
  const atStartup = !!plugin();
  await app.plugins.setEnable(true);
  document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click());
  const version = window.require?.("electron")?.ipcRenderer.sendSync("version") ?? document.title;
  return { version, atStartup, mobile: document.body.classList.contains("is-mobile") };
`);

async function pressKey(cdp, key, code, keyCode) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}

async function click(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

/** Closes whatever modal is open: the close button on desktop, Escape on mobile (no button there). */
async function closeModals(cdp) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = await cdp.evaluate(page(`return document.querySelectorAll(".modal-container").length;`), STEP_MS);
    if (!open) return;
    await cdp.evaluate(page(`document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click()); return 0;`), STEP_MS);
    await pressKey(cdp, "Escape", "Escape", 27);
    // Mobile modals slide out for about half a second before they leave the DOM.
    await cdp.evaluate(page(`return await until(() => !document.querySelector(".modal-container"), 2000);`), STEP_MS);
  }
  throw new StepFailure("a modal would not close");
}

async function screenshot(session, name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  const { data } = await session.cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(screenshotDir, `${session.pass}-${name}.png`), Buffer.from(data, "base64"));
}

/** Waits for a page condition across a reload, when the page's JS context comes and goes. */
async function waitAcrossReload(cdp, condition, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(300)) {
    try {
      if (await cdp.evaluate(condition, 3000)) return;
    } catch {
      // The context is being replaced.
    }
  }
  throw new StepFailure(`timed out waiting for ${condition}`);
}

/** The steps of one pass, in order. Each gets the session: its pass name and live connection. */
const steps = [
  {
    name: "open the fixture note",
    async run({ cdp }) {
      const mode = await cdp.evaluate(
        page(`
          const file = await until(() => app.vault.getFileByPath("Emoji.md"), 10000);
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(file, { state: { mode: "source", source: false } });
          app.workspace.setActiveLeaf(leaf, { focus: true });
          return noteLeaf().view.getMode();
        `),
        STEP_MS,
      );
      expect(mode === "source", `note opened in ${mode} mode`);
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
    name: "show emoji in live preview",
    async run(session) {
      const r = await session.cdp.evaluate(
        page(`
          const dom = noteLeaf().view.editor.cm.contentDOM;
          const count = () => ({ emoji: dom.querySelectorAll(".sf-emoji").length, images: dom.querySelectorAll("img.sf-attachment[src]").length });
          await until(() => count().emoji && count().images, 5000);
          return count();
        `),
        STEP_MS,
      );
      expect(r.emoji > 0 && r.images === 1, `live preview: ${JSON.stringify(r)}`);
      await screenshot(session, "1-live-preview");
    },
  },
  {
    name: "show emoji and the slack block in reading view",
    async run(session) {
      const r = await session.cdp.evaluate(
        page(`
          await setMode("preview");
          const el = noteLeaf().view.previewMode.containerEl;
          const count = () => ({
            blocks: el.querySelectorAll(".sf-block").length,
            emoji: el.querySelectorAll(".sf-emoji").length,
            images: el.querySelectorAll("img.sf-attachment[src]").length,
          });
          await until(() => count().blocks && count().emoji && count().images, 5000);
          return count();
        `),
        STEP_MS,
      );
      await screenshot(session, "2-reading");
      await session.cdp.evaluate(page(`await setMode("source"); return 0;`), STEP_MS);
      expect(r.blocks > 0 && r.emoji > 0 && r.images === 1, `reading view: ${JSON.stringify(r)}`);
    },
  },
  {
    name: "type :tad and pick from the emoji list",
    async run(session) {
      const { cdp } = session;
      const original = await cdp.evaluate(
        page(`
          const editor = noteLeaf().view.editor;
          const text = editor.getValue();
          editor.focus();
          const last = editor.lastLine();
          editor.setCursor({ line: last, ch: editor.getLine(last).length });
          editor.replaceSelection("\\n");
          return text;
        `),
        STEP_MS,
      );
      await cdp.send("Input.insertText", { text: ":tad" });
      const first = await cdp.evaluate(
        page(`return (await until(() => document.querySelector(".suggestion-container .sf-suggest-item"), 3000))?.textContent ?? null;`),
        STEP_MS,
      );
      await screenshot(session, "3-emoji-picker");
      if (first) await pressKey(cdp, "Enter", "Enter", 13);
      const line = await cdp.evaluate(
        page(`
          await sleep(200);
          const editor = noteLeaf().view.editor;
          const line = editor.getLine(editor.lastLine());
          editor.setValue(${JSON.stringify(original)});
          return line;
        `),
        STEP_MS,
      );
      expect(first?.includes(":tada:"), `emoji list: ${JSON.stringify(first)}`);
      expect(line.trim() === ":tada:", `after picking, the line is ${JSON.stringify(line)}`);
    },
  },
  {
    name: "open the plugin's settings",
    async run(session) {
      // The 500 ms timer is a macrotask: it never fires while a promise loop (like #4) spins.
      const items = await session.cdp.evaluate(
        page(`
          app.setting.open();
          app.setting.openTabById(${JSON.stringify(PLUGIN_ID)});
          await sleep(500);
          const tab = app.setting.activeTab;
          return tab?.id === ${JSON.stringify(PLUGIN_ID)} ? tab.containerEl.querySelectorAll(".setting-item").length : -1;
        `),
        STEP_MS,
      );
      await screenshot(session, "4-settings");
      expect(items >= 5, `settings items: ${items}`);
    },
  },
  {
    name: "add a workspace",
    async run(session) {
      const { cdp } = session;
      const r = await cdp.evaluate(
        page(`
          const el = app.setting.activeTab.containerEl;
          const button = [...el.querySelectorAll("button")].find((b) => b.textContent === plugin().strings.settingsAdd);
          if (!button) return { error: "no Add workspace button" };
          button.click();
          await sleep(500);
          return { workspaces: plugin().settings.workspaces.length, rows: el.querySelectorAll(".sf-workspace-setting").length };
        `),
        STEP_MS,
      );
      await screenshot(session, "5-workspace-row");
      await cdp.evaluate(page(`app.setting.close(); return 0;`), STEP_MS);
      await closeModals(cdp);
      expect(!r.error && r.workspaces === 1 && r.rows === 1, JSON.stringify(r));
    },
  },
  {
    name: "the block's refresh button stops before reading Slack",
    async run({ cdp }) {
      // Real mouse events: in live preview, a mousedown that reaches the editor would open the block for
      // editing and the button would vanish before the click. Without a token and with the workspace's
      // domain unknown, the plugin must stop at "domain not known" and never ask Slack anything.
      for (const mode of ["source", "preview"]) {
        const target = await cdp.evaluate(
          page(`
            await setMode(${JSON.stringify(mode)});
            const view = noteLeaf().view;
            if (view.getMode() === "source") view.editor.setCursor({ line: 0, ch: 0 });
            const root = view.getMode() === "source" ? view.editor.cm.contentDOM : view.previewMode.containerEl;
            const button = await until(() => root.querySelector(".sf-refresh"), 5000);
            if (!button) return null;
            button.scrollIntoView({ block: "center" });
            await sleep(300);
            const r = button.getBoundingClientRect();
            const expected = plugin().strings.refreshUnknownDomain(plugin().settings.workspaces[0].name);
            const before = [...document.querySelectorAll(".notice")].filter((n) => n.textContent === expected).length;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, before };
          `),
          STEP_MS,
        );
        expect(target, `no refresh button in ${mode} mode`);
        await click(cdp, target.x, target.y);
        const notices = await cdp.evaluate(
          page(`
            const expected = plugin().strings.refreshUnknownDomain(plugin().settings.workspaces[0].name);
            const texts = () => [...document.querySelectorAll(".notice")].map((n) => n.textContent);
            await until(() => texts().filter((t) => t === expected).length > ${target.before}, 3000);
            return { shown: texts().filter((t) => t === expected).length > ${target.before}, texts: texts() };
          `),
          STEP_MS,
        );
        expect(notices.shown, `${mode === "source" ? "live preview" : "reading view"}: notices ${JSON.stringify(notices.texts)}`);
      }
      await cdp.evaluate(page(`await setMode("source"); return 0;`), STEP_MS);
    },
  },
  {
    name: "the refresh button rewrites the block in place (Slack's answer stubbed)",
    async run({ cdp }) {
      // Only the network part is replaced: the button, finding the block, the edit and its checks are real.
      // Reading view goes through vault.process, live preview through the editor (so undo works).
      const original = await cdp.evaluate(page(`return await app.vault.read(noteLeaf().view.file);`), STEP_MS);
      try {
        for (const mode of ["preview", "source"]) {
          const marker = `refreshed in ${mode}`;
          const target = await cdp.evaluate(
            page(`
              await setMode(${JSON.stringify(mode)});
              const p = plugin();
              p.freshBlock = async () => ({ text: "\`\`\`slack\\nsource: https://example.slack.com/archives/C0123ABCD/p1790731800000100\\n\\n@bob 11:00\\n${marker}\\n\`\`\`", messages: 1 });
              const view = noteLeaf().view;
              if (view.getMode() === "source") view.editor.setCursor({ line: 0, ch: 0 });
              const root = view.getMode() === "source" ? view.editor.cm.contentDOM : view.previewMode.containerEl;
              const button = await until(() => root.querySelector(".sf-refresh"), 5000);
              if (!button) return null;
              button.scrollIntoView({ block: "center" });
              await sleep(300);
              const r = button.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            `),
            STEP_MS,
          );
          expect(target, `no refresh button in ${mode} mode`);
          await click(cdp, target.x, target.y);
          const r = await cdp.evaluate(
            page(`
              const view = noteLeaf().view;
              const text = () => (view.getMode() === "source" ? view.editor.getValue() : app.vault.cachedRead(view.file));
              for (let i = 0; i < 30 && !(await text()).includes(${JSON.stringify(marker)}); i++) await sleep(100);
              await sleep(300);
              const now = await text();
              return { replaced: now.includes(${JSON.stringify(marker)}), blocks: now.split("\`\`\`slack").length - 1, keptRest: now.includes("Hello :tada:") };
            `),
            STEP_MS,
          );
          expect(r.replaced && r.blocks === 1 && r.keptRest, `${mode === "source" ? "live preview" : "reading view"}: ${JSON.stringify(r)}`);
        }
      } finally {
        await cdp.evaluate(
          page(`
            delete plugin().freshBlock;
            await setMode("source");
            noteLeaf().view.editor.setValue(${JSON.stringify(original)});
            return 0;
          `),
          STEP_MS,
        );
      }
    },
  },
  {
    name: "save an attached image into the vault (Slack's download stubbed)",
    async run({ cdp }) {
      // Only the download is replaced: naming, the checks, the attachment path and the vault write are real.
      const r = await cdp.evaluate(
        page(`
          const p = plugin();
          const original = p.fileFetch;
          const png = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (c) => c.charCodeAt(0)).buffer;
          const asked = [];
          p.fileFetch = async (url) => {
            asked.push(url);
            return { status: 200, contentType: "image/png", data: png };
          };
          try {
            const file = { id: "F0SMOKE2", name: "shot.png", mimetype: "image/png", url_private: "https://files.slack.com/files-pri/T0-F0SMOKE2/shot.png", size: png.byteLength };
            const failures = [];
            const first = await p.saveSlackImage(file, "not-a-token", "Emoji.md", failures);
            const again = await p.saveSlackImage(file, "not-a-token", "Emoji.md", failures);
            const elsewhere = await p.saveSlackImage({ ...file, id: "F0SMOKE3", url_private: "https://example.com/x.png" }, "not-a-token", "Emoji.md", failures);
            const saved = first ? app.metadataCache.getFirstLinkpathDest(first, "Emoji.md") : null;
            const bytes = saved ? (await app.vault.readBinary(saved)).byteLength : 0;
            return { first, again, elsewhere, path: saved?.path ?? null, bytes, expected: png.byteLength, downloads: asked, failures };
          } finally {
            p.fileFetch = original;
          }
        `),
        STEP_MS,
      );
      expect(r.first === "slack-F0SMOKE2.png" && r.path === "slack-F0SMOKE2.png", `saved as ${JSON.stringify(r.first)} at ${JSON.stringify(r.path)}`);
      expect(r.bytes === r.expected, `saved ${r.bytes} bytes, expected ${r.expected}`);
      expect(r.again === r.first && r.downloads.length === 1, `second save: ${JSON.stringify(r.again)}, downloads ${JSON.stringify(r.downloads)}`);
      expect(r.elsewhere === null && r.failures.length === 0, `non-Slack URL: ${JSON.stringify(r.elsewhere)}, failures ${JSON.stringify(r.failures)}`);
    },
  },
  {
    name: "copy the note as Slack text",
    async run({ cdp }) {
      // The plugin writes through a copy event. Answer execCommand("copy") with a synthetic event whose
      // DataTransfer we keep, so the run never replaces what is on the system clipboard.
      const r = await cdp.evaluate(
        page(`
          app.workspace.setActiveLeaf(noteLeaf(), { focus: true });
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
    name: "copy falls back to plain text when the platform refuses",
    async run({ cdp }) {
      // What mobile WebViews do: no copy event, and the async API refuses rich content.
      const r = await cdp.evaluate(
        page(`
          app.workspace.setActiveLeaf(noteLeaf(), { focus: true });
          const exec = document.execCommand;
          let written = null;
          document.execCommand = (command, ...rest) => (command === "copy" ? false : exec.call(document, command, ...rest));
          navigator.clipboard.write = () => Promise.reject(new Error("refused by the smoke test"));
          navigator.clipboard.writeText = (text) => { written = text; return Promise.resolve(); };
          try {
            const ran = app.commands.executeCommandById(${JSON.stringify(PLUGIN_ID)} + ":copy-as-slack");
            await until(() => written !== null, 2000);
            const notice = [...document.querySelectorAll(".notice")].some((n) => n.textContent.includes(plugin().strings.copiedPlain));
            return { ran, written, notice };
          } finally {
            document.execCommand = exec;
            delete navigator.clipboard.write;
            delete navigator.clipboard.writeText;
          }
        `),
        STEP_MS,
      );
      expect(r.ran, "the command did not run");
      expect(typeof r.written === "string" && r.written.includes(":tada:"), `plain text written: ${JSON.stringify(r.written?.slice(0, 120))}`);
      expect(r.notice, "no notice saying only plain text was copied");
    },
  },
  {
    name: "run the other commands",
    async run({ cdp }) {
      const ran = {};
      for (const id of ["refresh-emoji", "switch-workspace", "import-thread"]) {
        ran[id] = await cdp.evaluate(
          page(`
            app.workspace.setActiveLeaf(noteLeaf(), { focus: true });
            const ran = app.commands.executeCommandById(${JSON.stringify(PLUGIN_ID)} + ":${id}");
            await sleep(300);
            return ran;
          `),
          STEP_MS,
        );
        await closeModals(cdp);
      }
      const failed = Object.entries(ran).filter(([, ok]) => ok !== true);
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

/** One pass on a fresh sandbox. Returns true when every step passed and the plugin logged no error. */
async function runPass(pass) {
  const sandbox = await createSandbox({ pluginDir });
  const errors = [];
  let obsidian = null;
  const session = {
    pass,
    mobile: pass === "mobile",
    cdp: null,
    async start() {
      obsidian = await sandbox.launch();
      this.cdp = await connect(obsidian.port, LAUNCH_MS);
      let boot = await this.cdp.evaluate(BOOT, LAUNCH_MS);
      // A new vault with plugins gets "Do you trust the author of this vault?" a moment after startup.
      // Plugins are already on (BOOT turned them on); the dialog would only take the keyboard focus.
      await this.cdp.evaluate(page(`return !!(await until(() => document.querySelector(".mod-trust-folder"), 2000));`), STEP_MS);
      await closeModals(this.cdp);
      if (this.mobile) {
        // Phone-sized first, so Obsidian picks its phone layout when it reloads into mobile mode.
        await this.cdp.send("Emulation.setDeviceMetricsOverride", PHONE);
        if (!boot.mobile) {
          // emulateMobile() reloads the window: fire it and come back, never await across the reload.
          await this.cdp.evaluate(`setTimeout(() => app.emulateMobile(true), 50), true`, STEP_MS);
          await delay(500);
          await waitAcrossReload(this.cdp, `document.body.classList.contains("is-mobile") && !!window.app?.workspace?.layoutReady`, LAUNCH_MS);
          boot = await this.cdp.evaluate(BOOT, LAUNCH_MS);
        }
        expect(boot.mobile, "Obsidian did not switch to its mobile UI");
      }
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
    console.log(`\n[${pass}] Obsidian ${version}${session.mobile ? ", mobile UI on a phone-sized window" : ""}`);
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
    console.log(`\n[${pass}]\n  ✗ start Obsidian: ${err.message}`);
    failed = true;
  } finally {
    await session.stop();
  }

  if (errors.length) {
    failed = true;
    console.log(`  ✗ the plugin logged ${errors.length} error(s):`);
    for (const e of errors) console.log(`    ${e.split("\n").join("\n    ")}`);
  }
  if (failed) {
    const log = await readFile(join(sandbox.root, "obsidian.log"), "utf8").catch(() => "");
    if (log.trim()) console.log(`\n  Last lines of Obsidian's output:\n${log.trim().split("\n").slice(-30).join("\n")}`);
  }
  await sandbox.dispose();
  return !failed;
}

async function main() {
  const { bin, asar } = (await import("./sandbox.mjs")).findObsidian();
  console.log(`Obsidian: ${bin}${asar ? `\n  app package: ${asar}` : ""}\nPlugin: ${pluginDir}`);
  let ok = true;
  for (const pass of passes) {
    if (pass !== "desktop" && pass !== "mobile") throw new Error(`unknown pass "${pass}" in SMOKE_PASSES`);
    ok = (await runPass(pass)) && ok;
  }
  if (screenshotDir) console.log(`\nScreenshots: ${screenshotDir}`);
  console.log(ok ? "\nSmoke test passed" : "\nSmoke test FAILED");
  process.exitCode = ok ? 0 : 1;
}

await main();
