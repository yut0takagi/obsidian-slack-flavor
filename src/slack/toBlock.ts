import type { SlackApiMessage } from "./client";

export interface ThreadToBlockDeps {
  userName: (id: string) => Promise<string>;
  channelName: (id: string) => Promise<string | undefined>;
  /** IANA zone for timestamps; defaults to the system zone. */
  timeZone?: string;
  /** Channel the thread lives in, written as the block's `channel:` line. */
  channel?: string;
  workspace?: string;
}

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const CHANNEL_MENTION = /<#([CG][A-Z0-9]+)>/g;

/** Converts a thread from conversations.replies into a fenced ```slack block. */
export async function threadToBlock(messages: SlackApiMessage[], deps: ThreadToBlockDeps): Promise<string> {
  const lines: string[] = [];
  if (deps.workspace) lines.push(`workspace: ${deps.workspace}`);
  if (deps.channel) lines.push(`channel: #${deps.channel.replace(/^#/, "")}`);

  const rootTs = messages[0]?.thread_ts ?? messages[0]?.ts;
  for (const msg of messages) {
    if (lines.length) lines.push("");
    const reply = msg.ts !== rootTs && msg.thread_ts === rootTs;
    lines.push(`${reply ? "↳ " : ""}@${await authorOf(msg, deps)} ${formatTs(msg.ts, deps.timeZone)}`);
    const body = await resolveMentions(msg.text ?? "", deps);
    if (body) lines.push(body);
    for (const f of msg.files ?? []) lines.push(`📎 <${f.permalink}|${f.title || f.name || "file"}>`);
    if (msg.reactions?.length) lines.push(`+${msg.reactions.map((r) => `:${r.name}: ${r.count}`).join(" ")}`);
  }

  const content = lines.join("\n");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}slack\n${content}\n${fence}`;
}

async function authorOf(msg: SlackApiMessage, deps: ThreadToBlockDeps): Promise<string> {
  const name = msg.user ? await deps.userName(msg.user) : msg.bot_profile?.name || msg.username || "bot";
  return name.trim();
}

async function resolveMentions(text: string, deps: ThreadToBlockDeps): Promise<string> {
  const users = new Map<string, string>();
  for (const [, id] of text.matchAll(USER_MENTION)) if (!users.has(id)) users.set(id, await deps.userName(id));
  const channels = new Map<string, string | undefined>();
  for (const [, id] of text.matchAll(CHANNEL_MENTION)) if (!channels.has(id)) channels.set(id, await deps.channelName(id));

  return text
    .replace(USER_MENTION, (_, id: string) => `<@${id}|${users.get(id)}>`)
    .replace(CHANNEL_MENTION, (raw, id: string) => (channels.get(id) ? `<#${id}|${channels.get(id)}>` : raw));
}

export function formatTs(ts: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Number(ts) * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function longestBacktickRun(s: string): number {
  return Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
}
