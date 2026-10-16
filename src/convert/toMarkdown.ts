/**
 * Slack mrkdwn -> Obsidian Markdown, the reverse of mdToMrkdwn, for importing a thread as ordinary
 * Markdown instead of a ```slack block. It works from the same AST the preview renders, so what was
 * plain text in Slack (e.g. `*` glued to Japanese) is escaped rather than turned into formatting.
 */

import type { SlackBlock, SlackMessage } from "../block/parse";
import { parseMrkdwn, type Block, type Inline, type ParseOptions } from "../mrkdwn/parse";
import { parsePermalink } from "../slack/permalink";

const SAFE_SCHEMES = /^(https?|mailto|tel|slack|obsidian):/i;
const MARKDOWN_SPECIAL = /[\\`*_~[\]<#$|^]/g;
const MENTION_PREFIX = { user: "@", channel: "\\#", special: "@", usergroup: "@" } as const;
const URL_UNSAFE: Record<string, string> = { " ": "%20", "(": "%28", ")": "%29", "<": "%3C", ">": "%3E" };

export function mrkdwnToMarkdown(src: string, opts: ParseOptions = {}): string {
  return parseMrkdwn(src, opts).flatMap(blockLines).join("\n");
}

/** A whole ```slack block as one quote callout: a header line per message, replies marked with ↳. */
export function slackBlockToMarkdown(block: SlackBlock, opts: ParseOptions = {}): string {
  const body: string[] = [];
  const add = (lines: string[]) => {
    if (body.length) body.push("");
    body.push(...lines);
  };
  if (block.text) add(mrkdwnToMarkdown(block.text, opts).split("\n"));
  const write = (msg: SlackMessage, reply: boolean) => {
    const lines = [`${reply ? "↳ " : ""}**${escapeText(msg.author)}**${msg.time ? ` ${msg.time}` : ""}`];
    if (msg.body) lines.push(...mrkdwnToMarkdown(msg.body, opts).split("\n"));
    if (msg.reactions.length) lines.push(msg.reactions.map((r) => `${r.emoji} ${r.count}`).join(" · "));
    add(lines);
    for (const r of msg.replies) write(r, true);
  };
  for (const msg of block.messages) write(msg, false);

  return [`> [!quote]${calloutTitle(block)}`, ...body.map((l) => (l ? `> ${l}` : ">"))].join("\n");
}

function calloutTitle(block: SlackBlock): string {
  const { channel, title, source } = block.meta;
  const parts = [channel && (channel.startsWith("#") ? channel : `#${channel}`), title].filter((p): p is string => !!p);
  const label = parts.map(escapeText).join(" · ");
  const link = source && /^https:\/\//.test(source) && parsePermalink(source) ? source : undefined;
  if (link) return ` [${label || "Slack"}](${escapeUrl(link)})`;
  return label ? ` ${label}` : "";
}

function blockLines(block: Block): string[] {
  switch (block.type) {
    case "paragraph":
      return inline(block.children).split("\n").map(guardLineStart);
    case "quote":
      return block.children.flatMap(blockLines).map((l) => (l ? `> ${l}` : ">"));
    case "pre": {
      const fence = "`".repeat(Math.max(3, longestRun(block.text, "`") + 1));
      return [fence, ...block.text.split("\n"), fence];
    }
  }
}

function inline(nodes: Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += escapeText(node.text);
        break;
      case "bold":
        out += `**${inline(node.children)}**`;
        break;
      case "italic":
        out += `*${inline(node.children)}*`;
        break;
      case "strike":
        out += `~~${inline(node.children)}~~`;
        break;
      case "code": {
        const ticks = "`".repeat(longestRun(node.text, "`") + 1);
        const pad = node.text.startsWith("`") || node.text.endsWith("`") ? " " : "";
        out += `${ticks}${pad}${node.text}${pad}${ticks}`;
        break;
      }
      case "link":
        out += link(node.url, node.label);
        break;
      case "mention":
        out += MENTION_PREFIX[node.kind] + escapeText(node.label);
        break;
      case "emoji":
        // Left as the code so the plugin (and Slack, when copied back) shows the workspace's emoji.
        out += node.raw;
        break;
      case "br":
        out += "\n";
        break;
    }
  }
  return out;
}

function link(url: string, label: string | undefined): string {
  if (!SAFE_SCHEMES.test(url)) return escapeText(label ?? url);
  if (label === undefined || label === url) return `<${url.replace(/[<> ]/g, (c) => URL_UNSAFE[c])}>`;
  return `[${escapeText(label)}](${escapeUrl(url)})`;
}

function escapeUrl(url: string): string {
  return url.replace(/[ ()<>]/g, (c) => URL_UNSAFE[c]);
}

/** Backslash-escapes what Obsidian would read as formatting, tags, math, comments or highlights. */
function escapeText(s: string): string {
  return s.replace(MARKDOWN_SPECIAL, "\\$&").replace(/==/g, "\\=\\=").replace(/%%/g, "\\%\\%");
}

/** A line of only dashes or equals signs would make the line above a heading (or become a rule). */
function guardLineStart(line: string): string {
  return /^\s*[-=]+\s*$/.test(line) ? line.replace(/[-=]/, "\\$&") : line;
}

function longestRun(s: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of s) {
    run = c === ch ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}
