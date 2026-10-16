import type { WorkspaceConfig } from "../settings";
import type { Permalink } from "./permalink";
import { formatTs } from "./toBlock";

/**
 * Checks before refreshing a block from its `source:` line. The block is note text, which anyone who
 * can write to the vault may have edited, so the link must belong to the workspace whose token is used.
 */
export type SourceCheck = { ok: true } | { ok: false; reason: "unknown-domain" | "other-workspace"; host: string };

export function checkRefreshSource(permalink: Permalink, workspace: WorkspaceConfig): SourceCheck {
  const host = permalink.domain.toLowerCase();
  if (!workspace.domain) return { ok: false, reason: "unknown-domain", host };
  return host === workspace.domain.toLowerCase() ? { ok: true } : { ok: false, reason: "other-workspace", host };
}

export interface RefreshSummary {
  workspace: string;
  channel: string;
  time: string;
}

/**
 * What the confirmation shows. Built only from the link, the registered workspace and the channel
 * name Slack returned, never from the block's `channel:` or `title:` lines, which could say anything.
 */
export function refreshSummary(
  workspace: WorkspaceConfig,
  permalink: Permalink,
  channelName: string | undefined,
  timeZone?: string,
): RefreshSummary {
  return {
    workspace: workspace.domain ? `${workspace.name} (${workspace.domain})` : workspace.name,
    channel: channelName ? `#${channelName} (${permalink.channel})` : permalink.channel,
    time: formatTs(permalink.threadTs ?? permalink.ts, timeZone),
  };
}
