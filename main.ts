import { type Editor, getLanguage, MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import { parseSlackBlock } from "./src/block/parse";
import { renderSlackBlock } from "./src/block/render";
import { slackClipboardData } from "./src/convert/clipboardData";
import { markdownToSlackDoc, mrkdwnToSlackDoc, type SlackLine } from "./src/convert/slackDoc";
import { resolveEmoji, type CustomEmojiMap, type EmojiResolver } from "./src/emoji/resolver";
import { createStrings, type Strings } from "./src/i18n";
import { emojiLivePreview } from "./src/obsidian/livePreview";
import { EmojiSuggest } from "./src/obsidian/emojiSuggest";
import { writeClipboard } from "./src/obsidian/clipboard";
import { obsidianHttp } from "./src/obsidian/http";
import { ImportModal } from "./src/obsidian/importModal";
import { renderNoteEmoji } from "./src/obsidian/readingView";
import { SlackFlavorSettingTab } from "./src/obsidian/settingsTab";
import { WorkspaceModal } from "./src/obsidian/workspaceModal";
import {
  DEFAULT_SETTINGS,
  NOTE_WORKSPACE_KEY,
  pickWorkspace,
  type SlackFlavorSettings,
  type WorkspaceConfig,
} from "./src/settings";
import { SlackClient } from "./src/slack/client";
import { describeError } from "./src/slack/errors";
import { parsePermalink } from "./src/slack/permalink";
import { threadToBlock } from "./src/slack/toBlock";
import { EmojiStore } from "./src/store/emojiStore";

export default class SlackFlavorPlugin extends Plugin {
  override settings: SlackFlavorSettings = structuredClone(DEFAULT_SETTINGS);
  strings: Strings = createStrings("en");
  store!: EmojiStore;
  private statusBar: HTMLElement | null = null;

  override async onload(): Promise<void> {
    this.strings = createStrings(getLanguage());
    await this.loadSettings();
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.store = new EmojiStore(this.app.vault.adapter, dir);
    await Promise.all(this.settings.workspaces.map((w) => this.store.load(w.id)));

    this.registerMarkdownCodeBlockProcessor("slack", (source, el, ctx) => this.renderBlock(source, el, ctx.sourcePath));
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (this.settings.renderEmojiInNotes) renderNoteEmoji(el, this.resolverFor(this.workspaceForPath(ctx.sourcePath)));
    });
    this.registerEditorExtension(emojiLivePreview(this));
    this.registerEditorSuggest(new EmojiSuggest(this));
    this.addSettingTab(new SlackFlavorSettingTab(this));
    this.registerCommands();

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.addEventListener("click", () => this.chooseDefaultWorkspace());
    this.updateStatusBar();
  }

  private registerCommands(): void {
    const s = this.strings;
    this.addCommand({ id: "copy-as-slack", name: s.cmdCopy, editorCallback: (editor) => this.copyAsSlack(editor) });
    this.addCommand({ id: "import-thread", name: s.cmdImport, editorCallback: (editor, view) => this.importThread(editor, view.file) });
    this.addCommand({ id: "switch-workspace", name: s.cmdSwitch, callback: () => this.chooseDefaultWorkspace() });
    this.addCommand({ id: "refresh-emoji", name: s.cmdRefresh, callback: () => this.refreshAllEmoji() });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem((item) => item.setTitle(s.menuCopy).setIcon("message-square").onClick(() => this.copyAsSlack(editor)));
      }),
    );
  }

  // --- workspaces -----------------------------------------------------------

  workspaceForPath(path: string, blockRef?: string): WorkspaceConfig | undefined {
    const file = this.app.vault.getFileByPath(path);
    const noteRef = file ? this.app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_WORKSPACE_KEY] : undefined;
    return pickWorkspace(this.settings, blockRef, typeof noteRef === "string" ? noteRef : undefined);
  }

  emojiFor(workspace: WorkspaceConfig | undefined): CustomEmojiMap | undefined {
    return workspace ? this.store.get(workspace.id) : undefined;
  }

  resolverFor(workspace: WorkspaceConfig | undefined): EmojiResolver {
    const custom = this.emojiFor(workspace);
    return (name, skinTone) => resolveEmoji(name, custom, skinTone);
  }

  tokenFor(workspace: WorkspaceConfig): string | null {
    return workspace.secret ? this.app.secretStorage.getSecret(workspace.secret) : null;
  }

  /** Reads team info and the emoji list, then saves both. Returns false (after a notice) on failure. */
  async fetchEmoji(workspace: WorkspaceConfig): Promise<boolean> {
    const token = this.tokenFor(workspace);
    if (!token) {
      new Notice(this.strings.noToken(workspace.name));
      return false;
    }
    const notice = new Notice(this.strings.fetching(workspace.name), 0);
    try {
      const client = new SlackClient(token, obsidianHttp);
      const auth = await client.authTest();
      const emoji = await client.emojiList();
      await this.store.save(workspace.id, emoji);
      workspace.domain = new URL(auth.url).hostname;
      workspace.teamId = auth.team_id;
      if (!workspace.name) workspace.name = auth.team;
      workspace.emojiCount = Object.keys(emoji).length;
      workspace.emojiFetchedAt = Date.now();
      await this.saveSettings();
      this.refreshViews();
      notice.setMessage(this.strings.fetched(workspace.name, workspace.emojiCount));
      window.setTimeout(() => notice.hide(), 4000);
      return true;
    } catch (err) {
      notice.hide();
      new Notice(`${workspace.name}: ${describeError(err, this.strings)}`);
      return false;
    }
  }

  private async refreshAllEmoji(): Promise<void> {
    if (!this.settings.workspaces.length) {
      new Notice(this.strings.noWorkspace);
      return;
    }
    for (const w of this.settings.workspaces) await this.fetchEmoji(w);
  }

  private chooseDefaultWorkspace(): void {
    if (!this.settings.workspaces.length) {
      new Notice(this.strings.noWorkspace);
      return;
    }
    new WorkspaceModal(this, async (w) => {
      this.settings.defaultWorkspace = w.id;
      await this.saveSettings();
      this.refreshViews();
    }).open();
  }

  // --- features -------------------------------------------------------------

  private renderBlock(source: string, el: HTMLElement, sourcePath: string): void {
    const block = parseSlackBlock(source);
    const workspace = this.workspaceForPath(sourcePath, block.meta.workspace);
    const label = block.meta.workspace ? (workspace?.name ?? `${block.meta.workspace} (?)`) : undefined;
    renderSlackBlock(block, el, {
      resolveEmoji: this.resolverFor(workspace),
      strings: this.strings,
      workspaceLabel: label,
      parseOptions: { strict: this.settings.strictBoundaries },
      onCopy: (text) => this.copyForSlack([{ type: "mrkdwn", text, lines: mrkdwnToSlackDoc(text) }]),
    });
  }

  private copyAsSlack(editor: Editor): void {
    const source = editor.somethingSelected() ? editor.getSelection() : editor.getValue();
    this.copyForSlack(markdownToSlackDoc(source));
  }

  /** Puts Slack's rich format, HTML and mrkdwn on the clipboard so pasting keeps formatting. */
  private copyForSlack(doc: SlackLine[]): void {
    const data = slackClipboardData(doc, { spaceAroundMarkers: this.settings.spaceAroundMarkers });
    if (writeClipboard(data)) {
      new Notice(this.strings.copied);
      return;
    }
    // No copy event (should not happen in Obsidian): fall back to HTML + text without slack/texty.
    const item = new ClipboardItem({
      "text/html": new Blob([data["text/html"]], { type: "text/html" }),
      "text/plain": new Blob([data["text/plain"]], { type: "text/plain" }),
    });
    navigator.clipboard.write([item]).then(
      () => new Notice(this.strings.copied),
      (err: unknown) => new Notice(describeError(err, this.strings)),
    );
  }

  private importThread(editor: Editor, file: TFile | null): void {
    if (!this.settings.workspaces.length) {
      new Notice(this.strings.noWorkspace);
      return;
    }
    const preferred = file ? this.workspaceForPath(file.path) : undefined;
    new ImportModal(this, preferred, async (link, workspace) => {
      const permalink = parsePermalink(link);
      if (!permalink) {
        new Notice(this.strings.badLink);
        return false;
      }
      const token = this.tokenFor(workspace);
      if (!token) {
        new Notice(this.strings.noToken(workspace.name));
        return false;
      }
      const notice = new Notice(this.strings.importing, 0);
      try {
        const client = new SlackClient(token, obsidianHttp);
        const messages = await client.replies(permalink.channel, permalink.threadTs ?? permalink.ts);
        const block = await threadToBlock(messages, {
          userName: (id) => client.userName(id),
          channelName: (id) => client.channelName(id),
          channel: await client.channelName(permalink.channel),
          workspace: workspace.id === this.workspaceForPath(file?.path ?? "")?.id ? undefined : workspace.name,
        });
        editor.replaceSelection(`${block}\n`);
        notice.setMessage(this.strings.imported(messages.length));
        window.setTimeout(() => notice.hide(), 3000);
        return true;
      } catch (err) {
        notice.hide();
        new Notice(describeError(err, this.strings));
        return false;
      }
    }).open();
  }

  // --- plumbing -------------------------------------------------------------

  /** Re-renders open notes so new emoji or a new default workspace show up. */
  refreshViews(): void {
    this.updateStatusBar();
    this.app.workspace.updateOptions();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    const w = pickWorkspace(this.settings);
    this.statusBar.setText(w ? this.strings.statusBar(w.name) : "");
    this.statusBar.toggle(!!w);
  }

  override async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    await Promise.all(this.settings.workspaces.map((w) => this.store.load(w.id)));
    this.refreshViews();
  }

  async loadSettings(): Promise<void> {
    // Clone so pushing a workspace never mutates the shared defaults.
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...((await this.loadData()) as Partial<SlackFlavorSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.updateStatusBar();
  }
}
