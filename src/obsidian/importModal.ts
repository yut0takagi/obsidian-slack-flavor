import { Modal, Setting } from "obsidian";
import { findWorkspace, type WorkspaceConfig } from "../settings";
import { parsePermalink } from "../slack/permalink";
import type SlackFlavorPlugin from "../../main";

/** Asks for a message link and a workspace; the workspace follows the link's domain when it is registered. */
export class ImportModal extends Modal {
  private link = "";
  private workspace: WorkspaceConfig;
  private busy = false;

  constructor(
    private readonly plugin: SlackFlavorPlugin,
    preferred: WorkspaceConfig | undefined,
    private readonly onSubmit: (link: string, workspace: WorkspaceConfig) => Promise<boolean>,
  ) {
    super(plugin.app);
    this.workspace = preferred ?? plugin.settings.workspaces[0];
  }

  override onOpen(): void {
    const s = this.plugin.strings;
    this.setTitle(s.importTitle);
    let select: HTMLSelectElement | undefined;

    new Setting(this.contentEl)
      .setName(s.importLink)
      .setDesc(s.importLinkDesc)
      .addText((text) => {
        text.setPlaceholder("https://…slack.com/archives/C…/p…").onChange((value) => {
          this.link = value.trim();
          const domain = parsePermalink(this.link)?.domain;
          const match = findWorkspace(this.plugin.settings, domain);
          if (match && select) {
            this.workspace = match;
            select.value = match.id;
          }
        });
        text.inputEl.addClass("sf-import-link");
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(this.contentEl).setName(s.importWorkspace).addDropdown((dd) => {
      for (const w of this.plugin.settings.workspaces) dd.addOption(w.id, w.name);
      dd.setValue(this.workspace.id).onChange((id) => {
        this.workspace = this.plugin.settings.workspaces.find((w) => w.id === id) ?? this.workspace;
      });
      select = dd.selectEl;
    });

    let button: HTMLButtonElement | undefined;
    new Setting(this.contentEl).addButton((btn) => {
      btn.setButtonText(s.importButton).setCta().onClick(() => this.submit(btn.buttonEl));
      button = btn.buttonEl;
    });

    this.scope.register([], "Enter", () => {
      if (button) void this.submit(button);
      return false;
    });
  }

  /** One import at a time: the button stays disabled until Slack answers. */
  private async submit(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    button.disabled = true;
    const ok = await this.onSubmit(this.link, this.workspace);
    this.busy = false;
    button.disabled = false;
    if (ok) this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
