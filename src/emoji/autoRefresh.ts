import type { WorkspaceConfig } from "../settings";

export const DAY_MS = 86_400_000;

/**
 * True when a workspace's emoji list should be fetched again: it has a token and the list is missing
 * or at least `days` old. `days` of 0 (or anything not positive) turns automatic refreshing off.
 */
export function isEmojiStale(w: WorkspaceConfig, days: number, now: number): boolean {
  if (!w.secret || !(days > 0)) return false;
  const at = w.emojiFetchedAt;
  // A stamp in the future means the clock was off when it was written; refetch rather than wait.
  return at === undefined || at > now || now - at >= days * DAY_MS;
}

export interface RefreshOutcome {
  refreshed: WorkspaceConfig[];
  failed: { workspace: WorkspaceConfig; error: unknown }[];
}

/**
 * Refreshes stale lists one workspace at a time (Slack rate-limits per token, and startup should stay
 * light). A failure leaves that workspace's saved list as it was and does not stop the others.
 */
export async function refreshStaleEmoji(
  workspaces: WorkspaceConfig[],
  days: number,
  now: number,
  refresh: (workspace: WorkspaceConfig) => Promise<void>,
): Promise<RefreshOutcome> {
  const outcome: RefreshOutcome = { refreshed: [], failed: [] };
  for (const workspace of workspaces) {
    if (!isEmojiStale(workspace, days, now)) continue;
    try {
      await refresh(workspace);
      outcome.refreshed.push(workspace);
    } catch (error) {
      outcome.failed.push({ workspace, error });
    }
  }
  return outcome;
}
