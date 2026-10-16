import { type App, Modal, Setting } from "obsidian";
import type { Strings } from "../i18n";
import type { RefreshSummary } from "../slack/refresh";

/** Shows which thread will be read with the user's token before anything is fetched; resolves true on "Refresh". */
export function confirmRefresh(app: App, s: Strings, summary: RefreshSummary): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.setTitle(s.refreshConfirmTitle);
        this.contentEl.createEl("p", { text: s.refreshConfirmDesc });
        new Setting(this.contentEl).setName(s.refreshConfirmWorkspace).setDesc(summary.workspace);
        new Setting(this.contentEl).setName(s.refreshConfirmChannel).setDesc(summary.channel);
        new Setting(this.contentEl).setName(s.refreshConfirmThread).setDesc(summary.time);
        new Setting(this.contentEl)
          .addButton((btn) => btn.setButtonText(s.cancel).onClick(() => this.close()))
          .addButton((btn) =>
            btn
              .setButtonText(s.refreshConfirmButton)
              .setCta()
              .onClick(() => {
                answered = true;
                this.close();
              }),
          );
      }

      override onClose(): void {
        this.contentEl.empty();
        resolve(answered);
      }
    })(app);
    modal.open();
  });
}
