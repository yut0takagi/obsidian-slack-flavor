import type { SlackBlock, SlackBlockMeta, SlackMessage } from "../block/parse";
import type { SlackApiMessage } from "./client";

export interface ThreadToBlockDeps {
  userName: (id: string) => Promise<string>;
  channelName: (id: string) => Promise<string | undefined>;
  /** IANA zone for timestamps; defaults to the system zone. */
  timeZone?: string;
  /** Channel the thread lives in, written as the block's `channel:` line. */
  channel?: string;
  workspace?: string;
  title?: string;
  /** Link to the thread, written as `source:` so the block can be refreshed later. */
  source?: string;
}

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const CHANNEL_MENTION = /<#([CG][A-Z0-9]+)>/g;

/** Converts a thread from conversations.replies into a fenced ```slack block. */
export async function threadToBlock(messages: SlackApiMessage[], deps: ThreadToBlockDeps): Promise<string> {
  return formatSlackBlock(await threadToSlackBlock(messages, deps));
}

/** The thread as a parsed block (replies nested under their parent), shared by the block and Markdown outputs. */
export async function threadToSlackBlock(messages: SlackApiMessage[], deps: ThreadToBlockDeps): Promise<SlackBlock> {
  const meta: SlackBlockMeta = {};
  if (deps.workspace) meta.workspace = deps.workspace;
  if (deps.channel) meta.channel = `#${deps.channel.replace(/^#/, "")}`;
  if (deps.title) meta.title = deps.title;
  if (deps.source) meta.source = deps.source;

  const rootTs = messages[0]?.thread_ts ?? messages[0]?.ts;
  const out: SlackMessage[] = [];
  for (const msg of messages) {
    const reply = msg.ts !== rootTs && msg.thread_ts === rootTs;
    const body = [await resolveMentions(msg.text ?? "", deps)];
    for (const f of msg.files ?? []) body.push(`📎 <${f.permalink}|${f.title || f.name || "file"}>`);
    const message: SlackMessage = {
      author: await authorOf(msg, deps),
      time: formatTs(msg.ts, deps.timeZone),
      body: body.filter(Boolean).join("\n"),
      reactions: (msg.reactions ?? []).map((r) => ({ emoji: `:${r.name}:`, count: r.count })),
      replies: [],
    };
    const parent = out[out.length - 1];
    if (reply && parent) parent.replies.push(message);
    else out.push(message);
  }
  return { meta, text: "", messages: out };
}

/** Writes a block in the ```slack format that parseSlackBlock reads. */
export function formatSlackBlock(block: SlackBlock): string {
  const lines: string[] = [];
  for (const key of ["workspace", "channel", "title", "source"] as const) {
    if (block.meta[key]) lines.push(`${key}: ${block.meta[key]}`);
  }
  if (block.text) {
    if (lines.length) lines.push("");
    lines.push(block.text);
  }
  const write = (msg: SlackMessage, reply: boolean) => {
    if (lines.length) lines.push("");
    lines.push(`${reply ? "↳ " : ""}@${msg.author}${msg.time ? ` ${msg.time}` : ""}`);
    if (msg.body) lines.push(msg.body);
    if (msg.reactions.length) lines.push(`+${msg.reactions.map((r) => `${r.emoji} ${r.count}`).join(" ")}`);
    for (const r of msg.replies) write(r, true);
  };
  for (const msg of block.messages) write(msg, false);

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
