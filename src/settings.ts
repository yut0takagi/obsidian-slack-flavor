export interface WorkspaceConfig {
  /** Internal id, also the emoji file name. */
  id: string;
  /** Display name; also accepted in `workspace:` lines and the `slack-workspace` property. */
  name: string;
  /** Name of the SecretStorage entry holding the token (never the token itself). */
  secret: string;
  /** Filled from auth.test, e.g. "acme.slack.com". */
  domain?: string;
  teamId?: string;
  emojiCount?: number;
  emojiFetchedAt?: number;
}

export interface SlackFlavorSettings {
  workspaces: WorkspaceConfig[];
  defaultWorkspace: string | null;
  /** Format `*` `_` `~` only where Slack would (not when glued to Japanese text). */
  strictBoundaries: boolean;
  renderEmojiInNotes: boolean;
  /** Pad converted markers with spaces so Slack formats them next to Japanese. */
  spaceAroundMarkers: boolean;
}

export const DEFAULT_SETTINGS: SlackFlavorSettings = {
  workspaces: [],
  defaultWorkspace: null,
  strictBoundaries: true,
  renderEmojiInNotes: true,
  spaceAroundMarkers: true,
};

/** Frontmatter property that picks the workspace for a note. */
export const NOTE_WORKSPACE_KEY = "slack-workspace";

export function findWorkspace(settings: SlackFlavorSettings, ref: string | undefined): WorkspaceConfig | undefined {
  const r = ref?.trim().toLowerCase();
  if (!r) return undefined;
  return settings.workspaces.find(
    (w) =>
      w.id === r ||
      w.name.toLowerCase() === r ||
      w.teamId?.toLowerCase() === r ||
      w.domain === r ||
      w.domain?.split(".")[0] === r,
  );
}

/**
 * Block `workspace:` wins, then the note's property, then the default. A block that names an
 * unknown workspace gets none, so its custom emoji show as codes instead of another team's images.
 */
export function pickWorkspace(settings: SlackFlavorSettings, blockRef?: string, noteRef?: string): WorkspaceConfig | undefined {
  if (blockRef?.trim()) return findWorkspace(settings, blockRef);
  return (
    findWorkspace(settings, noteRef) ??
    settings.workspaces.find((w) => w.id === settings.defaultWorkspace) ??
    settings.workspaces[0]
  );
}

export function newWorkspaceId(existing: WorkspaceConfig[]): string {
  for (;;) {
    const id = `ws-${Math.random().toString(36).slice(2, 8)}`;
    if (!existing.some((w) => w.id === id)) return id;
  }
}
