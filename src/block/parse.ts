/**
 * The ```slack code block format:
 *
 *   workspace: acme      <- optional meta lines (workspace / channel / title / source)
 *   channel: #general
 *   source: https://acme.slack.com/archives/C…/p…   <- where an imported thread came from
 *
 *   @田中 10:30                <- message header: at the top or after a blank line
 *   body in Slack mrkdwn
 *   ![[slack-F0123.png]]       <- an image saved in the vault, on a line of its own
 *   +:tada: 3 :eyes:           <- trailing reaction lines
 *
 *   ↳ @山田 10:32              <- "↳" or ">>" marks a thread reply
 *   reply body
 *
 * A block with no headers is a single piece of mrkdwn (`text`).
 */

import { EMOJI_NAME } from "../emoji/pattern";

export interface Reaction {
  /** The emoji code as written, e.g. ":+1::skin-tone-2:". */
  emoji: string;
  count: number;
}

export interface SlackMessage {
  author: string;
  time?: string;
  body: string;
  reactions: Reaction[];
  replies: SlackMessage[];
}

export interface SlackBlockMeta {
  workspace?: string;
  channel?: string;
  title?: string;
  /** Link to the thread's root message, written on import so the block can be refreshed. */
  source?: string;
}

export interface SlackBlock {
  meta: SlackBlockMeta;
  /** Text before the first message header; the whole block when there are no headers. */
  text: string;
  messages: SlackMessage[];
}

const META = /^(workspace|channel|title|source)\s*:\s*(.*)$/i;
/** `![[name.png]]` or `![[name.png|300]]` alone on a line; the link text never contains ] | # ^ or a newline. */
const IMAGE_EMBED = /^\s*!\[\[([^\]|#^\n]+?)(?:\|[^\]\n]*)?\]\]\s*$/;
const TIME = String.raw`(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+)?\d{1,2}:\d{2}`;
const HEADER = new RegExp(String.raw`^(?:(↳|>>)\s*)?@(.+?)(?:\s+(${TIME}))?\s*$`);
const REACTION_EMOJI = String.raw`:${EMOJI_NAME}:(?::skin-tone-[2-6]:)?`;
const REACTION_LINE = new RegExp(String.raw`^\+\s*(?:${REACTION_EMOJI}\s*\d*\s*)+$`);
const REACTION_ITEM = new RegExp(String.raw`(${REACTION_EMOJI})\s*(\d*)`, "g");

interface Header {
  reply: boolean;
  author: string;
  time?: string;
}

export function parseSlackBlock(src: string): SlackBlock {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const meta: SlackBlockMeta = {};
  let start = 0;
  for (; start < lines.length; start++) {
    const m = META.exec(lines[start]);
    if (!m) break;
    meta[m[1].toLowerCase() as keyof SlackBlockMeta] = m[2].trim();
  }

  const textLines: string[] = [];
  const messages: SlackMessage[] = [];
  let current: { header: Header; lines: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    const msg = toMessage(current.header, current.lines);
    const parent = messages[messages.length - 1];
    if (current.header.reply && parent) parent.replies.push(msg);
    else messages.push(msg);
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const header = i === start || !lines[i - 1].trim() ? parseHeader(line) : null;
    if (header) {
      finish();
      current = { header, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      textLines.push(line);
    }
  }
  finish();

  return { meta, text: trimBlankLines(textLines).join("\n"), messages };
}

function parseHeader(line: string): Header | null {
  const m = HEADER.exec(line);
  if (!m) return null;
  const [, marker, author, time] = m;
  // Without a time, "@山田 了解です" would read as a header; require a single-word name then.
  if (!time && /\s/.test(author)) return null;
  return time ? { reply: !!marker, author, time } : { reply: !!marker, author };
}

function toMessage(header: Header, lines: string[]): SlackMessage {
  const body = trimBlankLines(lines);
  const reactions: Reaction[] = [];
  while (body.length && REACTION_LINE.test(body[body.length - 1])) {
    const line = body.pop() as string;
    reactions.unshift(...[...line.matchAll(REACTION_ITEM)].map((m) => ({ emoji: m[1], count: m[2] ? Number(m[2]) : 1 })));
  }
  const msg: SlackMessage = { author: header.author, body: trimBlankLines(body).join("\n"), reactions, replies: [] };
  if (header.time) msg.time = header.time;
  return msg;
}

function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/** A message body split into its mrkdwn and the images embedded on lines of their own (in order). */
export function splitImageEmbeds(body: string): { text: string; images: string[] } {
  const text: string[] = [];
  const images: string[] = [];
  for (const line of body.split("\n")) {
    const link = imageEmbedLink(line);
    if (link) images.push(link);
    else text.push(line);
  }
  return { text: text.join("\n"), images };
}

/** The link text of a line that is only an image embed, or null. */
export function imageEmbedLink(line: string): string | null {
  return IMAGE_EMBED.exec(line)?.[1].trim() ?? null;
}
