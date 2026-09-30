import { append } from "../dom";
import { parseInline, parseMrkdwn, type ParseOptions } from "../mrkdwn/parse";
import { createEmojiEl, isEmojiOnly, renderBlocks, type RenderContext } from "../mrkdwn/render";
import type { SlackBlock, SlackMessage } from "./parse";

export interface BlockRenderContext extends RenderContext {
  strings: { replies: (count: number) => string; copy: string };
  workspaceLabel?: string;
  parseOptions?: ParseOptions;
  /** When set, copy buttons are shown and receive the raw mrkdwn. */
  onCopy?: (mrkdwn: string) => void;
}

const AVATAR_COLORS = 8;
const GROUP_WINDOW_MINUTES = 5;
const DATED_TIME = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2})$/;

export function renderSlackBlock(block: SlackBlock, parent: HTMLElement, ctx: BlockRenderContext): void {
  const root = append(parent, "div", "sf-block");
  renderHeader(block, root, ctx);

  if (block.text) {
    const text = append(root, "div", "sf-text");
    if (ctx.onCopy && !block.messages.length) copyButton(root, block.text, ctx);
    renderMrkdwn(block.text, text, ctx);
  }
  if (!block.messages.length) return;

  const list = append(root, "div", "sf-messages");
  let prev: SlackMessage | undefined;
  let lastDate: string | undefined;
  for (const msg of block.messages) {
    const date = DATED_TIME.exec(msg.time ?? "")?.[1];
    if (date && date !== lastDate) {
      append(append(list, "div", "sf-date-divider"), "span").textContent = date;
      lastDate = date;
    }
    renderMessage(msg, list, ctx, !!prev && continues(prev, msg), false);
    prev = msg;
  }
}

function renderHeader(block: SlackBlock, root: HTMLElement, ctx: BlockRenderContext): void {
  const { channel, title } = block.meta;
  if (!channel && !title && !ctx.workspaceLabel) return;
  const header = append(root, "div", "sf-header");
  if (channel) append(header, "span", "sf-channel").textContent = channel.startsWith("#") ? channel : `#${channel}`;
  if (title) append(header, "span", "sf-title").textContent = title;
  if (ctx.workspaceLabel) append(header, "span", "sf-workspace").textContent = ctx.workspaceLabel;
}

function renderMessage(msg: SlackMessage, parent: HTMLElement, ctx: BlockRenderContext, continued: boolean, reply: boolean): void {
  const el = append(parent, "div", "sf-message");
  if (continued) el.classList.add("sf-continued");
  if (reply) el.classList.add("sf-reply");

  const time = displayTime(msg.time);
  if (continued) {
    if (time) append(el, "span", "sf-gutter-time").textContent = time;
  } else {
    append(el, "div", `sf-avatar sf-avatar-c${colorIndex(msg.author)}`).textContent = Array.from(msg.author)[0] ?? "?";
  }

  const content = append(el, "div", "sf-content");
  if (!continued) {
    const meta = append(content, "div", "sf-meta");
    append(meta, "span", "sf-author").textContent = msg.author;
    if (time) append(meta, "span", "sf-time").textContent = time;
  }
  if (ctx.onCopy && msg.body) copyButton(el, msg.body, ctx);

  const body = append(content, "div", "sf-body");
  const blocks = parseMrkdwn(msg.body, ctx.parseOptions);
  if (isEmojiOnly(blocks, ctx)) body.classList.add("sf-jumbo");
  renderBlocks(blocks, body, ctx);

  if (msg.reactions.length) {
    const row = append(content, "div", "sf-reactions");
    for (const r of msg.reactions) {
      const pill = append(row, "span", "sf-reaction");
      pill.setAttribute("title", r.emoji);
      const tok = parseInline(r.emoji).find((t) => t.type === "emoji");
      const resolved = tok?.type === "emoji" ? ctx.resolveEmoji(tok.name, tok.skinTone) : null;
      pill.appendChild(resolved ? createEmojiEl(pill.ownerDocument, resolved) : pill.ownerDocument.createTextNode(r.emoji));
      append(pill, "span", "sf-reaction-count").textContent = String(r.count);
    }
  }

  if (msg.replies.length) {
    const thread = append(content, "div", "sf-thread");
    append(thread, "div", "sf-thread-summary").textContent = ctx.strings.replies(msg.replies.length);
    for (const r of msg.replies) renderMessage(r, thread, ctx, false, true);
  }
}

function renderMrkdwn(src: string, parent: HTMLElement, ctx: BlockRenderContext): void {
  renderBlocks(parseMrkdwn(src, ctx.parseOptions), parent, ctx);
}

function copyButton(parent: HTMLElement, mrkdwn: string, ctx: BlockRenderContext): void {
  const btn = append(parent, "button", "sf-copy");
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", ctx.strings.copy);
  btn.textContent = ctx.strings.copy;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.onCopy?.(mrkdwn);
  });
}

/** Slack folds a message into the previous one from the same author a few minutes apart. */
function continues(prev: SlackMessage, msg: SlackMessage): boolean {
  if (prev.author !== msg.author || prev.replies.length) return false;
  if (!prev.time && !msg.time) return true;
  const a = toMinutes(prev.time);
  const b = toMinutes(msg.time);
  return a !== null && b !== null && b - a >= 0 && b - a <= GROUP_WINDOW_MINUTES;
}

function toMinutes(time: string | undefined): number | null {
  const m = /^(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+)?(\d{1,2}):(\d{2})$/.exec(time ?? "");
  if (!m) return null;
  const days = m[1] ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 : 0;
  return days * 1440 + +m[4] * 60 + +m[5];
}

function displayTime(time: string | undefined): string | undefined {
  return time ? (DATED_TIME.exec(time)?.[2] ?? time) : undefined;
}

function colorIndex(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % AVATAR_COLORS;
}
