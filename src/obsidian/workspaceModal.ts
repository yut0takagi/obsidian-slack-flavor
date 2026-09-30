import { SuggestModal } from "obsidian";
import { pickWorkspace, type WorkspaceConfig } from "../settings";
import type SlackFlavorPlugin from "../../main";

export class WorkspaceModal extends SuggestModal<WorkspaceConfig> {
  constructor(
    private readonly plugin: SlackFlavorPlugin,
    private readonly onChoose: (workspace: WorkspaceConfig) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder(plugin.strings.switchPlaceholder);
  }

  getSuggestions(query: string): WorkspaceConfig[] {
    const q = query.toLowerCase();
    return this.plugin.settings.workspaces.filter((w) => `${w.name} ${w.domain ?? ""}`.toLowerCase().includes(q));
  }

  renderSuggestion(w: WorkspaceConfig, el: HTMLElement): void {
    const current = pickWorkspace(this.plugin.settings)?.id === w.id;
    el.createDiv({ text: `${current ? "✓ " : ""}${w.name}` });
    if (w.domain) el.createEl("small", { text: w.domain, cls: "sf-muted" });
  }

  onChooseSuggestion(w: WorkspaceConfig): void {
    this.onChoose(w);
  }
}
