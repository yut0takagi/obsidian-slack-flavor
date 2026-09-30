import { PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { newWorkspaceId, type WorkspaceConfig } from "../settings";
import type SlackFlavorPlugin from "../../main";

export class SlackFlavorSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: SlackFlavorPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    const { containerEl, plugin } = this;
    const s = plugin.strings;
    containerEl.empty();

    new Setting(containerEl).setName(s.settingsWorkspaces).setDesc(s.settingsWorkspacesDesc).setHeading();
    for (const w of plugin.settings.workspaces) this.workspaceSettings(w);

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText(s.settingsAdd).onClick(async () => {
        const id = newWorkspaceId(plugin.settings.workspaces);
        plugin.settings.workspaces.push({ id, name: "", secret: "" });
        plugin.settings.defaultWorkspace ??= id;
        await plugin.saveSettings();
        this.display();
      }),
    );

    if (plugin.settings.workspaces.length > 1) {
      new Setting(containerEl)
        .setName(s.settingsDefault)
        .setDesc(s.settingsDefaultDesc)
        .addDropdown((dd) => {
          for (const w of plugin.settings.workspaces) dd.addOption(w.id, w.name || w.id);
          dd.setValue(plugin.settings.defaultWorkspace ?? plugin.settings.workspaces[0].id).onChange(async (id) => {
            plugin.settings.defaultWorkspace = id;
            await plugin.saveSettings();
            plugin.refreshViews();
          });
        });
    }

    new Setting(containerEl).setName(s.settingsRendering).setHeading();
    this.toggle(s.settingsStrict, s.settingsStrictDesc, "strictBoundaries");
    this.toggle(s.settingsNoteEmoji, s.settingsNoteEmojiDesc, "renderEmojiInNotes");

    new Setting(containerEl).setName(s.settingsConvert).setHeading();
    this.toggle(s.settingsPad, s.settingsPadDesc, "spaceAroundMarkers");
  }

  private workspaceSettings(w: WorkspaceConfig): void {
    const { containerEl, plugin } = this;
    const s = plugin.strings;
    const status = w.emojiFetchedAt
      ? s.settingsFetchedAt(w.emojiCount ?? 0, new Date(w.emojiFetchedAt).toLocaleString(), w.domain)
      : s.settingsNotFetched;

    new Setting(containerEl)
      .setName(w.name || s.settingsName)
      .setDesc(status)
      .setClass("sf-workspace-setting")
      .addText((text) =>
        text
          .setPlaceholder(s.settingsName)
          .setValue(w.name)
          .onChange(async (value) => {
            w.name = value.trim();
            await plugin.saveSettings();
          }),
      )
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(w.secret).onChange(async (value) => {
          w.secret = value;
          await plugin.saveSettings();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(s.settingsFetch).onClick(async () => {
          btn.setDisabled(true);
          if (await plugin.fetchEmoji(w)) this.display();
          else btn.setDisabled(false);
        }),
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("trash-2")
          .setTooltip(s.settingsRemove)
          .onClick(async () => {
            plugin.settings.workspaces = plugin.settings.workspaces.filter((x) => x.id !== w.id);
            if (plugin.settings.defaultWorkspace === w.id) plugin.settings.defaultWorkspace = plugin.settings.workspaces[0]?.id ?? null;
            await plugin.store.remove(w.id);
            await plugin.saveSettings();
            plugin.refreshViews();
            this.display();
          }),
      );
  }

  private toggle(name: string, desc: string, key: "strictBoundaries" | "renderEmojiInNotes" | "spaceAroundMarkers"): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        }),
      );
  }
}
