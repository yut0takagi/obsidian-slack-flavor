import { type App, Modal, Setting, SuggestModal } from "obsidian";
import type { Strings } from "../i18n";
import type { ScheduledMessage, SlackChannel } from "../slack/client";
import { checkPostAt, fromLocalInput, notifications, toLocalInput } from "../slack/post";

export type Destination = { kind: "channel"; channel: SlackChannel } | { kind: "thread" };

/** Step 1: where to post. The first entry asks for a message link instead, to reply in its thread. */
export class DestinationModal extends SuggestModal<Destination> {
  constructor(
    app: App,
    private readonly s: Strings,
    private readonly channels: SlackChannel[],
    private readonly onChoose: (destination: Destination) => void,
  ) {
    super(app);
    this.setPlaceholder(s.postPickChannel);
  }

  getSuggestions(query: string): Destination[] {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    const matches = this.channels
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .map((channel): Destination => ({ kind: "channel", channel }));
    return [{ kind: "thread" }, ...matches];
  }

  renderSuggestion(d: Destination, el: HTMLElement): void {
    if (d.kind === "thread") {
      el.createDiv({ text: this.s.postReplyInThread });
      el.createEl("small", { text: this.s.postReplyInThreadDesc, cls: "sf-muted" });
      return;
    }
    el.createDiv({ text: `${d.channel.private ? "🔒 " : "#"}${d.channel.name}` });
  }

  onChooseSuggestion(d: Destination): void {
    this.onChoose(d);
  }
}

/** Asks for a Slack message link; resolves null when cancelled. */
export function askThreadLink(app: App, s: Strings): Promise<string | null> {
  return new Promise((resolve) => {
    let link: string | null = null;
    let value = "";
    new (class extends Modal {
      override onOpen(): void {
        this.setTitle(s.postThreadLinkTitle);
        this.contentEl.createEl("p", { text: s.postThreadLinkDesc });
        new Setting(this.contentEl).setName(s.importLink).addText((t) => {
          t.inputEl.addClass("sf-import-link");
          t.onChange((v) => (value = v.trim()));
        });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText(s.cancel).onClick(() => this.close()))
          .addButton((b) =>
            b
              .setButtonText(s.postThreadLinkButton)
              .setCta()
              .onClick(() => {
                link = value || null;
                this.close();
              }),
          );
      }

      override onClose(): void {
        this.contentEl.empty();
        resolve(link);
      }
    })(app).open();
  });
}

export interface PostSummary {
  workspace: string;
  destination: string;
  /** Exactly what will be sent. */
  text: string;
}

/**
 * Step 2: shows where and what before anything is sent. `send` returns true to close the dialog; the
 * send button is disabled while it runs so one click can never post twice.
 */
export class ConfirmPostModal extends Modal {
  constructor(
    app: App,
    private readonly s: Strings,
    private readonly summary: PostSummary,
    private readonly send: (postAt: number | undefined) => Promise<boolean>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { s, summary, contentEl } = this;
    this.setTitle(s.postConfirmTitle);
    contentEl.createEl("p", { text: s.postConfirmDesc });
    new Setting(contentEl).setName(s.refreshConfirmWorkspace).setDesc(summary.workspace);
    new Setting(contentEl).setName(s.postWhere).setDesc(summary.destination);

    const notify = notifications(summary.text);
    if (notify.broadcasts.length || notify.users || notify.groups) {
      contentEl.createDiv({ cls: "sf-post-warning", text: s.postNotifies(notify) });
    }
    contentEl.createEl("pre", { cls: "sf-post-preview", text: summary.text });

    let schedule = false;
    let when = toLocalInput(new Date(Date.now() + 60 * 60_000));
    let sendButton: { setButtonText: (t: string) => unknown; setDisabled: (d: boolean) => unknown } | null = null;
    let whenRow: Setting | null = null;
    new Setting(contentEl)
      .setName(s.postSchedule)
      .setDesc(s.postScheduleDesc)
      .addToggle((t) =>
        t.setValue(false).onChange((on) => {
          schedule = on;
          whenRow?.settingEl.toggle(on);
          sendButton?.setButtonText(on ? s.postScheduleButton : s.postButton);
        }),
      );
    whenRow = new Setting(contentEl).setName(s.postWhen).addText((t) => {
      t.inputEl.type = "datetime-local";
      t.inputEl.addClass("sf-post-when");
      t.setValue(when);
      t.onChange((v) => (when = v));
    });
    whenRow.settingEl.toggle(false);
    const error = contentEl.createDiv({ cls: "sf-post-error" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(s.cancel).onClick(() => this.close()))
      .addButton((b) => {
        sendButton = b;
        b.setButtonText(s.postButton)
          .setCta()
          .onClick(async () => {
            let postAt: number | undefined;
            if (schedule) {
              const check = checkPostAt(fromLocalInput(when), new Date());
              if (!check.ok) {
                error.setText(s.postTime(check.reason));
                return;
              }
              postAt = check.postAt;
            }
            error.setText("");
            b.setDisabled(true);
            if (await this.send(postAt)) this.close();
            else b.setDisabled(false);
          });
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export interface ScheduledItem {
  message: ScheduledMessage;
  /** "#general", or the channel id when its name is unknown. */
  channel: string;
}

/** Lists messages scheduled with this token; each can be removed before it is sent. */
export class ScheduledModal extends Modal {
  constructor(
    app: App,
    private readonly s: Strings,
    private readonly items: ScheduledItem[],
    private readonly remove: (message: ScheduledMessage) => Promise<boolean>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { s, contentEl } = this;
    this.setTitle(s.scheduledTitle);
    if (!this.items.length) {
      contentEl.createEl("p", { text: s.scheduledNone });
      return;
    }
    for (const item of [...this.items].sort((a, b) => a.message.postAt - b.message.postAt)) {
      const text = item.message.text.replace(/\s+/g, " ").trim();
      const row = new Setting(contentEl)
        .setName(`${new Date(item.message.postAt * 1000).toLocaleString()} · ${item.channel}`)
        .setDesc(text.length > 120 ? `${text.slice(0, 120)}…` : text)
        .setClass("sf-scheduled-row")
        .addButton((b) =>
          b
            .setButtonText(s.scheduledRemove)
            .setWarning()
            .onClick(async () => {
              b.setDisabled(true);
              if (await this.remove(item.message)) row.settingEl.remove();
              else b.setDisabled(false);
            }),
        );
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
