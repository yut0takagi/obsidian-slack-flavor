import { type Editor, getLanguage, MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import { blockAt, findSlackBlocks } from "./src/block/locate";
import { parseSlackBlock } from "./src/block/parse";
import { renderSlackBlock } from "./src/block/render";
import { slackClipboardData } from "./src/convert/clipboardData";
import { markdownToSlackDoc, mrkdwnToSlackDoc, type SlackLine } from "./src/convert/slackDoc";
import { slackBlockToMarkdown } from "./src/convert/toMarkdown";
import { refreshStaleEmoji } from "./src/emoji/autoRefresh";
import { resolveEmoji, withImageUrl, type CustomEmojiMap, type EmojiResolver } from "./src/emoji/resolver";
import { createStrings, type Strings } from "./src/i18n";
import { emojiLivePreview } from "./src/obsidian/livePreview";
import { EmojiSuggest } from "./src/obsidian/emojiSuggest";
import { browserClipboardWriters, copyWithFallback } from "./src/obsidian/clipboard";
import { confirmRefresh } from "./src/obsidian/confirmRefreshModal";
import { obsidianHttp, obsidianImageFetch } from "./src/obsidian/http";
import { ImportModal } from "./src/obsidian/importModal";
import { renderNoteEmoji } from "./src/obsidian/readingView";
import { SlackFlavorSettingTab } from "./src/obsidian/settingsTab";
import { WorkspaceModal } from "./src/obsidian/workspaceModal";
import {
  DEFAULT_SETTINGS,
  findWorkspace,
  NOTE_WORKSPACE_KEY,
  pickWorkspace,
  type SlackFlavorSettings,
  type WorkspaceConfig,
} from "./src/settings";
import { SlackApiError, SlackClient } from "./src/slack/client";
import { describeError } from "./src/slack/errors";
import { parsePermalink, threadPermalink } from "./src/slack/permalink";
import { checkRefreshSource, refreshSummary } from "./src/slack/refresh";
import { formatSlackBlock, threadToBlock, threadToSlackBlock } from "./src/slack/toBlock";
import { EmojiStore } from "./src/store/emojiStore";
import { EmojiImageCache } from "./src/store/imageCache";

/** Wait a little after the layout is ready so the refresh never competes with opening the vault. */
const AUTO_REFRESH_DELAY_MS = 5000;
const MB = 1024 * 1024;

export default class SlackFlavorPlugin extends Plugin {
  override settings: SlackFlavorSettings = structuredClone(DEFAULT_SETTINGS);
  strings: Strings = createStrings("en");
  store!: EmojiStore;
  imageCache!: EmojiImageCache;
  private statusBar: HTMLElement | null = null;

  override async onload(): Promise<void> {
    this.strings = createStrings(getLanguage());
    await this.loadSettings();
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.store = new EmojiStore(this.app.vault.adapter, dir);
    await Promise.all(this.settings.workspaces.map((w) => this.store.load(w.id)));
    this.imageCache = new EmojiImageCache(this.app.vault.adapter, `${dir}/emoji-cache`, obsidianImageFetch, {
      maxBytes: () => Math.max(0, this.settings.emojiCacheMB || 0) * MB,
    });
    // Awaited so the first render already finds local copies (that is what makes emoji show offline).
    await this.imageCache.load().catch(() => undefined);

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

    this.app.workspace.onLayoutReady(() => {
      // registerInterval clears it on unload; clearInterval also cancels a timeout.
      this.registerInterval(window.setTimeout(() => void this.autoRefreshEmoji(), AUTO_REFRESH_DELAY_MS));
    });
  }

  private registerCommands(): void {
    const s = this.strings;
    this.addCommand({ id: "copy-as-slack", name: s.cmdCopy, editorCallback: (editor) => this.copyAsSlack(editor) });
    this.addCommand({ id: "import-thread", name: s.cmdImport, editorCallback: (editor, view) => this.importThread(editor, view.file) });
    this.addCommand({
      id: "refresh-thread",
      name: s.cmdRefreshThread,
      editorCallback: (editor, view) => void this.refreshThread(editor, view.file),
    });
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

  /** Custom emoji resolve to the local copy when there is one; showing one saves it for next time. */
  resolverFor(workspace: WorkspaceConfig | undefined): EmojiResolver {
    const custom = this.emojiFor(workspace);
    return withImageUrl(
      (name, skinTone) => resolveEmoji(name, custom, skinTone),
      (url) => this.imageCache.displayUrl(url),
    );
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
      await this.downloadEmoji(workspace, token);
      notice.setMessage(this.strings.fetched(workspace.name, workspace.emojiCount ?? 0));
      window.setTimeout(() => notice.hide(), 4000);
      return true;
    } catch (err) {
      notice.hide();
      new Notice(`${workspace.name}: ${describeError(err, this.strings)}`);
      return false;
    }
  }

  /** Saves the list only after both calls succeed, so a failed fetch keeps the previous list. */
  private async downloadEmoji(workspace: WorkspaceConfig, token: string): Promise<void> {
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
  }

  /** Startup refresh of lists older than emojiRefreshDays: quiet when it works, at most one notice when it does not. */
  private async autoRefreshEmoji(): Promise<void> {
    const { failed } = await refreshStaleEmoji(this.settings.workspaces, this.settings.emojiRefreshDays, Date.now(), async (w) => {
      const token = this.tokenFor(w);
      if (token) await this.downloadEmoji(w, token);
    });
    // Network errors (offline, flaky mobile data) stay silent and are retried at the next start;
    // Slack's own errors, such as a revoked token, need the user.
    const reportable = failed.filter((f) => f.error instanceof SlackApiError);
    if (!reportable.length) return;
    const names = reportable.map((f) => f.workspace.name).join(", ");
    new Notice(this.strings.autoRefreshFailed(names, describeError(reportable[0].error, this.strings)));
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
      onCopy: (text) => void this.copyForSlack([{ type: "mrkdwn", text, lines: mrkdwnToSlackDoc(text) }]),
    });
  }

  private copyAsSlack(editor: Editor): void {
    const source = editor.somethingSelected() ? editor.getSelection() : editor.getValue();
    void this.copyForSlack(markdownToSlackDoc(source));
  }

  /** Puts Slack's rich format, HTML and mrkdwn on the clipboard; falls back to less when the platform refuses. */
  private async copyForSlack(doc: SlackLine[]): Promise<void> {
    const data = slackClipboardData(doc, { spaceAroundMarkers: this.settings.spaceAroundMarkers });
    const outcome = await copyWithFallback(data, browserClipboardWriters());
    if (outcome.kind === "plain") new Notice(this.strings.copiedPlain, 8000);
    else if (outcome.kind === "failed") new Notice(this.strings.copyFailed(describeError(outcome.error, this.strings)));
    else new Notice(this.strings.copied);
  }

  private importThread(editor: Editor, file: TFile | null): void {
    if (!this.settings.workspaces.length) {
      new Notice(this.strings.noWorkspace);
      return;
    }
    const preferred = file ? this.workspaceForPath(file.path) : undefined;
    new ImportModal(this, preferred, async (link, workspace, format) => {
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
        const rootTs = messages[0]?.thread_ts ?? messages[0]?.ts ?? permalink.threadTs ?? permalink.ts;
        // app.slack.com links work only in the browser client; prefer the workspace's own domain.
        const domain = permalink.domain === "app.slack.com" ? (workspace.domain ?? permalink.domain) : permalink.domain;
        const block = await threadToSlackBlock(messages, {
          userName: (id) => client.userName(id),
          channelName: (id) => client.channelName(id),
          channel: await client.channelName(permalink.channel),
          workspace: workspace.id === this.workspaceForPath(file?.path ?? "")?.id ? undefined : workspace.name,
          source: threadPermalink(domain, permalink.channel, rootTs) ?? undefined,
        });
        const text = format === "markdown" ? slackBlockToMarkdown(block, { strict: this.settings.strictBoundaries }) : formatSlackBlock(block);
        editor.replaceSelection(`${text}\n`);
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

  /**
   * Re-reads the thread a block was imported from and replaces the block with the current replies and
   * reactions. The block is note text that others may have written (shared or synced vaults), so only
   * the block under the cursor is used, its link must be on the token's own workspace, and the user
   * confirms the workspace, channel and thread before anything is read.
   */
  private async refreshThread(editor: Editor, file: TFile | null): Promise<void> {
    const s = this.strings;
    const lines = editor.getValue().split("\n");
    const target = blockAt(findSlackBlocks(lines), editor.getCursor().line);
    if (!target) {
      new Notice(s.noBlockHere);
      return;
    }
    const meta = parseSlackBlock(target.content).meta;
    const permalink = meta.source ? parsePermalink(meta.source) : null;
    if (!permalink) {
      new Notice(s.noSource);
      return;
    }
    const workspace =
      findWorkspace(this.settings, meta.workspace) ?? findWorkspace(this.settings, permalink.domain) ?? this.workspaceForPath(file?.path ?? "");
    if (!workspace) {
      new Notice(s.noWorkspace);
      return;
    }
    const check = checkRefreshSource(permalink, workspace);
    if (!check.ok) {
      new Notice(check.reason === "unknown-domain" ? s.refreshUnknownDomain(workspace.name) : s.refreshOtherWorkspace(check.host, workspace.name));
      return;
    }
    const token = this.tokenFor(workspace);
    if (!token) {
      new Notice(s.noToken(workspace.name));
      return;
    }

    const client = new SlackClient(token, obsidianHttp);
    // Only the channel's name is looked up before the user agrees; it is shown in the dialog, not written anywhere.
    const channelName = await client.channelName(permalink.channel);
    if (!(await confirmRefresh(this.app, s, refreshSummary(workspace, permalink, channelName)))) return;

    const notice = new Notice(s.refreshing, 0);
    try {
      const messages = await client.replies(permalink.channel, permalink.threadTs ?? permalink.ts);
      const fresh = await threadToBlock(messages, {
        userName: (id) => client.userName(id),
        channelName: (id) => client.channelName(id),
        channel: channelName ?? meta.channel,
        workspace: meta.workspace,
        title: meta.title,
        source: meta.source,
      });
      // The note may have been edited while Slack answered: only replace the block if it is unchanged.
      const now = editor.getValue().split("\n");
      const unchanged = now.slice(target.start, target.end + 1).join("\n") === lines.slice(target.start, target.end + 1).join("\n");
      notice.hide();
      if (!unchanged) {
        new Notice(s.blockChanged);
        return;
      }
      editor.replaceRange(fresh, { line: target.start, ch: 0 }, { line: target.end, ch: now[target.end].length });
      new Notice(s.refreshed(messages.length));
    } catch (err) {
      notice.hide();
      new Notice(describeError(err, s));
    }
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
