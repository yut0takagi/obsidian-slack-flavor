export interface Permalink {
  domain: string;
  channel: string;
  /** The linked message. */
  ts: string;
  /** Set when the link points into a thread. */
  threadTs?: string;
}

const ARCHIVES = /^\/archives\/([A-Z0-9]+)\/p(\d{7,})\/?$/;
const CLIENT_THREAD = /^\/client\/[A-Z0-9]+\/([A-Z0-9]+)\/thread\/[A-Z0-9]+-(\d+\.\d+)\/?$/;

/** Parses "Copy link" URLs from Slack: /archives/C…/p… (optionally ?thread_ts=) and web-client thread URLs. */
export function parsePermalink(input: string): Permalink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)slack\.com$/.test(url.hostname)) return null;

  const archive = ARCHIVES.exec(url.pathname);
  if (archive) {
    const digits = archive[2];
    const link: Permalink = { domain: url.hostname, channel: archive[1], ts: `${digits.slice(0, -6)}.${digits.slice(-6)}` };
    const threadTs = url.searchParams.get("thread_ts");
    if (threadTs) link.threadTs = threadTs;
    return link;
  }

  const thread = CLIENT_THREAD.exec(url.pathname);
  if (thread) return { domain: url.hostname, channel: thread[1], ts: thread[2], threadTs: thread[2] };
  return null;
}
