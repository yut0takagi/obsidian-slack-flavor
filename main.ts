import { type Editor, getLanguage, type MarkdownPostProcessorContext, MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import { blockAt, blockUnchanged, findSlackBlocks, replaceBlock, type SlackBlockRange } from "./src/block/locate";
import { parseSlackBlock } from "./src/block/parse";
import { renderSlackBlock } from "./src/block/render";
import { slackClipboardData } from "./src/convert/clipboardData";
import { markdownToSlackDoc, mrkdwnToSlackDoc, type SlackLine } from "./src/convert/slackDoc";
import { slackDocToMrkdwn } from "./src/convert/mdToMrkdwn";
import { slackBlockToMarkdown } from "./src/convert/toMarkdown";
import { refreshStaleEmoji } from "./src/emoji/autoRefresh";
import { resolveEmoji, withImageUrl, type CustomEmojiMap, type EmojiResolver } from "./src/emoji/resolver";
import { createStrings, type Strings } from "./src/i18n";
import { emojiLivePreview } from "./src/obsidian/livePreview";
import { EmojiSuggest } from "./src/obsidian/emojiSuggest";
import { browserClipboardWriters, copyWithFallback } from "./src/obsidian/clipboard";
import { confirmRefresh } from "./src/obsidian/confirmRefreshModal";
import { obsidianFileFetch, obsidianHttp, obsidianImageFetch } from "./src/obsidian/http";
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
import { type HttpFn, SlackApiError, SlackClient, type SlackChannel, type SlackFile } from "./src/slack/client";
import { checkPostText } from "./src/slack/post";
import { askThreadLink, ConfirmPostModal, type Destination, DestinationModal, ScheduledModal } from "./src/obsidian/postModals";
import { checkImageResponse, type FileFetch, imageDownloadUrl, imageFileName } from "./src/slack/files";
import { describeError } from "./src/slack/errors";
import { parsePermalink, threadPermalink } from "./src/slack/permalink";
import { checkRefreshSource, refreshSummary } from "./src/slack/refresh";
import { formatSlackBlock, formatTs, threadToBlock, threadToSlackBlock } from "./src/slack/toBlock";
import { EmojiStore } from "./src/store/emojiStore";
import { EmojiImageCache } from "./src/store/imageCache";

/** Wait a little after the layout is ready so the refresh never competes with opening the vault. */
const AUTO_REFRESH_DELAY_MS = 5000;
const MB = 1024 * 1024;

/** A refreshed block: its new text, fences included, and how many messages it holds. */
interface FreshBlock {
  text: string;
  messages: number;
}

/** Images shown from `![[…]]` lines in a block; anything else in the vault stays text. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);

/** Why attached images were not saved during one import or refresh ("login": probably no files:read). */
type ImageFailures = string[];

export default class SlackFlavorPlugin extends Plugin {
  override settings: SlackFlavorSettings = structuredClone(DEFAULT_SETTINGS);
  strings: Strings = createStrings("en");
  store!: EmojiStore;
  imageCache!: EmojiImageCache;
  /** Downloads Slack files with the token; a field so the smoke test can answer for Slack. */
  fileFetch: FileFetch = obsidianFileFetch;
  /** Calls Slack's Web API; a field so the smoke test can answer for Slack. */
  http: HttpFn = obsidianHttp;
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

    this.registerMarkdownCodeBlockProcessor("slack", (source, el, ctx) => this.renderBlock(source, el, ctx));
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
    // Posting cannot be undone, so its commands only exist once it is allowed in the settings.
    this.addCommand({
      id: "post-to-slack",
      name: s.cmdPost,
      editorCheckCallback: (checking, editor, view) => {
        if (!this.settings.allowPosting) return false;
        if (!checking) void this.postToSlack(editor, view.file);
        return true;
      },
    });
    this.addCommand({
      id: "scheduled-messages",
      name: s.cmdScheduled,
      checkCallback: (checking) => {
        if (!this.settings.allowPosting) return false;
        if (!checking) void this.showScheduled();
        return true;
      },
    });
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
    const client = this.client(token);
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

  private renderBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const block = parseSlackBlock(source);
    const workspace = this.workspaceForPath(ctx.sourcePath, block.meta.workspace);
    const label = block.meta.workspace ? (workspace?.name ?? `${block.meta.workspace} (?)`) : undefined;
    renderSlackBlock(block, el, {
      resolveEmoji: this.resolverFor(workspace),
      resolveImage: (link) => {
        const file = this.app.metadataCache.getFirstLinkpathDest(link, ctx.sourcePath);
        return file && IMAGE_EXTENSIONS.has(file.extension.toLowerCase()) ? this.app.vault.getResourcePath(file) : null;
      },
      strings: this.strings,
      workspaceLabel: label,
      parseOptions: { strict: this.settings.strictBoundaries },
      onCopy: (text) => void this.copyForSlack([{ type: "mrkdwn", text, lines: mrkdwnToSlackDoc(text) }]),
      onRefresh: () => this.refreshRenderedBlock(el, ctx),
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
        const client = this.client(token);
        const messages = await client.replies(permalink.channel, permalink.threadTs ?? permalink.ts);
        const rootTs = messages[0]?.thread_ts ?? messages[0]?.ts ?? permalink.threadTs ?? permalink.ts;
        // app.slack.com links work only in the browser client; prefer the workspace's own domain.
        const domain = permalink.domain === "app.slack.com" ? (workspace.domain ?? permalink.domain) : permalink.domain;
        const failures: ImageFailures = [];
        const block = await threadToSlackBlock(messages, {
          userName: (id) => client.userName(id),
          channelName: (id) => client.channelName(id),
          channel: await client.channelName(permalink.channel),
          workspace: workspace.id === this.workspaceForPath(file?.path ?? "")?.id ? undefined : workspace.name,
          source: threadPermalink(domain, permalink.channel, rootTs) ?? undefined,
          saveImage: this.imageSaver(token, file?.path ?? "", failures),
        });
        const text = format === "markdown" ? slackBlockToMarkdown(block, { strict: this.settings.strictBoundaries }) : formatSlackBlock(block);
        editor.replaceSelection(`${text}\n`);
        notice.setMessage(this.strings.imported(messages.length));
        window.setTimeout(() => notice.hide(), 3000);
        this.reportImageFailures(failures);
        return true;
      } catch (err) {
        notice.hide();
        new Notice(describeError(err, this.strings));
        return false;
      }
    }).open();
  }

  /** Command: refreshes the block under the cursor. */
  private async refreshThread(editor: Editor, file: TFile | null): Promise<void> {
    const lines = editor.getValue().split("\n");
    const target = blockAt(findSlackBlocks(lines), editor.getCursor().line);
    if (!target) {
      new Notice(this.strings.noBlockHere);
      return;
    }
    const fresh = await this.freshBlock(target.content, file?.path ?? "");
    if (fresh) this.replaceInEditor(editor, lines, target, fresh);
  }

  /** The refresh button in a rendered block's header: the block is the one Obsidian rendered there. */
  private async refreshRenderedBlock(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const s = this.strings;
    const file = this.app.vault.getFileByPath(ctx.sourcePath);
    const info = ctx.getSectionInfo(el);
    const lines = info ? info.text.split("\n") : [];
    const target = info ? findSlackBlocks(lines).find((b) => b.start === info.lineStart) : undefined;
    if (!file || !target) {
      new Notice(s.noBlockPosition);
      return;
    }
    const fresh = await this.freshBlock(target.content, file.path);
    if (!fresh) return;
    // Through the editor when the note is open in one, so the change can be undone; otherwise the file.
    const editing = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source");
    if (editing) {
      this.replaceInEditor(editing.editor, lines, target, fresh);
      return;
    }
    let replaced = false;
    await this.app.vault.process(file, (data) => {
      const next = replaceBlock(data.split("\n"), lines, target, fresh.text);
      replaced = next !== null;
      return next ? next.join("\n") : data;
    });
    new Notice(replaced ? s.refreshed(fresh.messages) : s.blockChanged);
  }

  /** Replaces the block unless it was edited or moved while Slack answered. */
  private replaceInEditor(editor: Editor, before: string[], target: SlackBlockRange, fresh: FreshBlock): void {
    const now = editor.getValue().split("\n");
    if (!blockUnchanged(now, before, target)) {
      new Notice(this.strings.blockChanged);
      return;
    }
    editor.replaceRange(fresh.text, { line: target.start, ch: 0 }, { line: target.end, ch: now[target.end].length });
    new Notice(this.strings.refreshed(fresh.messages));
  }

  /**
   * Re-reads the thread a block was imported from and returns the block's new text (fences included),
   * or null after telling the user why not. The block is note text that others may have written (shared
   * or synced vaults), so callers only pass a block the user pointed at (cursor or the block's own
   * button), its link must be on the token's own workspace, and the user confirms the workspace,
   * channel and thread before anything is read.
   */
  private async freshBlock(content: string, sourcePath: string): Promise<FreshBlock | null> {
    const s = this.strings;
    const meta = parseSlackBlock(content).meta;
    const permalink = meta.source ? parsePermalink(meta.source) : null;
    if (!permalink) {
      new Notice(s.noSource);
      return null;
    }
    const workspace =
      findWorkspace(this.settings, meta.workspace) ?? findWorkspace(this.settings, permalink.domain) ?? this.workspaceForPath(sourcePath);
    if (!workspace) {
      new Notice(s.noWorkspace);
      return null;
    }
    const check = checkRefreshSource(permalink, workspace);
    if (!check.ok) {
      new Notice(check.reason === "unknown-domain" ? s.refreshUnknownDomain(workspace.name) : s.refreshOtherWorkspace(check.host, workspace.name));
      return null;
    }
    const token = this.tokenFor(workspace);
    if (!token) {
      new Notice(s.noToken(workspace.name));
      return null;
    }

    const client = this.client(token);
    // Only the channel's name is looked up before the user agrees; it is shown in the dialog, not written anywhere.
    const channelName = await client.channelName(permalink.channel);
    if (!(await confirmRefresh(this.app, s, refreshSummary(workspace, permalink, channelName)))) return null;

    const notice = new Notice(s.refreshing, 0);
    try {
      const messages = await client.replies(permalink.channel, permalink.threadTs ?? permalink.ts);
      const failures: ImageFailures = [];
      const text = await threadToBlock(messages, {
        userName: (id) => client.userName(id),
        channelName: (id) => client.channelName(id),
        channel: channelName ?? meta.channel,
        workspace: meta.workspace,
        title: meta.title,
        source: meta.source,
        saveImage: this.imageSaver(token, sourcePath, failures),
      });
      this.reportImageFailures(failures);
      return { text, messages: messages.length };
    } catch (err) {
      new Notice(describeError(err, s));
      return null;
    } finally {
      notice.hide();
    }
  }

  /** The image saver for one import or refresh, when saving attached images is turned on. */
  private imageSaver(token: string, sourcePath: string, failures: ImageFailures): ((file: SlackFile) => Promise<string | null>) | undefined {
    return this.settings.importImages ? (file) => this.saveSlackImage(file, token, sourcePath, failures) : undefined;
  }

  /**
   * Saves an image attached to a Slack message as an attachment of the note and returns the link text
   * to embed, or null to keep it a link. An image saved before (same Slack file id) is reused. Only
   * URLs from Slack's API reach here, and the download itself refuses anything but files.slack.com.
   */
  async saveSlackImage(file: SlackFile, token: string, sourcePath: string, failures: ImageFailures): Promise<string | null> {
    const name = imageFileName(file);
    const url = imageDownloadUrl(file);
    if (!name || !url) return null;
    const existing = this.app.metadataCache.getFirstLinkpathDest(name, sourcePath);
    if (existing) return this.app.metadataCache.fileToLinktext(existing, sourcePath, true);
    try {
      const res = await this.fileFetch(url, token);
      const check = checkImageResponse(res);
      if (!check.ok) {
        failures.push(check.reason);
        return null;
      }
      const path = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
      const saved = await this.app.vault.createBinary(path, res.data);
      return this.app.metadataCache.fileToLinktext(saved, sourcePath, true);
    } catch {
      failures.push("error");
      return null;
    }
  }

  private reportImageFailures(failures: ImageFailures): void {
    if (failures.length) new Notice(this.strings.imagesNotSaved(failures.length, failures.includes("login")), 8000);
  }

  // --- posting ----------------------------------------------------------------

  /** Posts the selection (or the whole note) as Slack mrkdwn, after the user picks where and confirms. */
  private async postToSlack(editor: Editor, file: TFile | null): Promise<void> {
    const s = this.strings;
    const source = editor.somethingSelected() ? editor.getSelection() : editor.getValue();
    // The same conversion as the plain-text copy, so what is shown is what is sent.
    const text = slackDocToMrkdwn(markdownToSlackDoc(source), { spaceAroundMarkers: this.settings.spaceAroundMarkers });
    const problem = checkPostText(text);
    if (problem) {
      new Notice(problem === "empty" ? s.postEmpty : s.postTooLong);
      return;
    }
    const workspace = this.workspaceForPath(file?.path ?? "");
    if (!workspace) {
      new Notice(s.noWorkspace);
      return;
    }
    const token = this.tokenFor(workspace);
    if (!token) {
      new Notice(s.noToken(workspace.name));
      return;
    }
    const client = this.client(token);
    let channels: SlackChannel[] = [];
    try {
      channels = await client.memberChannels();
    } catch (err) {
      new Notice(s.postChannelsFailed(describeError(err, s)));
    }
    new DestinationModal(this.app, s, channels, (d) => void this.confirmPost(client, workspace, d, text)).open();
  }

  private async confirmPost(client: SlackClient, workspace: WorkspaceConfig, destination: Destination, text: string): Promise<void> {
    const s = this.strings;
    let channel: string;
    let threadTs: string | undefined;
    let label: string;
    if (destination.kind === "channel") {
      channel = destination.channel.id;
      label = `${destination.channel.private ? "🔒 " : "#"}${destination.channel.name}`;
    } else {
      const link = await askThreadLink(this.app, s);
      if (!link) return;
      const permalink = parsePermalink(link);
      if (!permalink) {
        new Notice(s.badLink);
        return;
      }
      // The link is pasted text: it must be on the workspace whose token posts.
      const check = checkRefreshSource(permalink, workspace);
      if (!check.ok) {
        new Notice(check.reason === "unknown-domain" ? s.refreshUnknownDomain(workspace.name) : s.refreshOtherWorkspace(check.host, workspace.name));
        return;
      }
      channel = permalink.channel;
      threadTs = permalink.threadTs ?? permalink.ts;
      const name = await client.channelName(channel);
      label = s.postThreadIn(name ? `#${name}` : channel, formatTs(threadTs));
    }
    const summary = { workspace: workspace.domain ? `${workspace.name} (${workspace.domain})` : workspace.name, destination: label, text };
    new ConfirmPostModal(this.app, s, summary, async (postAt) => {
      try {
        if (postAt !== undefined) {
          await client.scheduleMessage(channel, text, postAt, threadTs);
          new Notice(s.postScheduled(label, new Date(postAt * 1000).toLocaleString()), 8000);
        } else {
          const posted = await client.postMessage(channel, text, threadTs);
          this.noticeWithLink(s.posted(label), await client.permalink(posted.channel, posted.ts));
        }
        return true;
      } catch (err) {
        // Slack refused: nothing was sent, so the dialog stays open to try again. Anything else (the
        // connection failed) may have happened after Slack posted it: close and say so instead.
        if (err instanceof SlackApiError) {
          new Notice(describeError(err, s));
          return false;
        }
        new Notice(s.postUncertain, 0);
        return true;
      }
    }).open();
  }

  private async showScheduled(): Promise<void> {
    const s = this.strings;
    const workspace = this.workspaceForPath(this.app.workspace.getActiveFile()?.path ?? "");
    if (!workspace) {
      new Notice(s.noWorkspace);
      return;
    }
    const token = this.tokenFor(workspace);
    if (!token) {
      new Notice(s.noToken(workspace.name));
      return;
    }
    const client = this.client(token);
    try {
      const messages = await client.scheduledMessages();
      const names = new Map<string, string | undefined>();
      for (const m of messages) if (!names.has(m.channel)) names.set(m.channel, await client.channelName(m.channel));
      const items = messages.map((message) => ({ message, channel: names.get(message.channel) ? `#${names.get(message.channel)}` : message.channel }));
      new ScheduledModal(this.app, s, items, async (message) => {
        try {
          await client.deleteScheduledMessage(message.channel, message.id);
          new Notice(s.scheduledRemoved);
          return true;
        } catch (err) {
          new Notice(describeError(err, s));
          return false;
        }
      }).open();
    } catch (err) {
      new Notice(describeError(err, s));
    }
  }

  private noticeWithLink(message: string, link: string | undefined): void {
    new Notice(
      createFragment((f) => {
        f.appendText(message);
        if (link && /^https:\/\/[a-z0-9.-]+\.slack\.com\//i.test(link)) {
          f.appendText(" ");
          f.createEl("a", { text: this.strings.openInSlack, href: link });
        }
      }),
      8000,
    );
  }

  private client(token: string): SlackClient {
    return new SlackClient(token, this.http);
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
